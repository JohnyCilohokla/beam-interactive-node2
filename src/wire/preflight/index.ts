import { IRawValues } from '../../interfaces';
import fetch,{ Response } from 'node-fetch'; //tslint:disable-line

import { PreflightError, preflightErrors } from './errors';


const statusOK = 200;
const statusBad = 400;
const badMessage = 'Bad Request\n';

/**
 * Performs a Http request to the interactive websocket endpoint.
 * This will shake loose any errors before a websocket connection
 * is made. The reason this is done is that browser websockets
 * can't receive http status codes.
 *
 * On an actually valid http request we still get 400. But the message
 * is a generic "Bad Request" text rather than a useful error message.
 * We take this as a signal that the preflight has succeeded and that
 * we should try again with a regular websocket request.
 *
 * Otherwise we throw an appropriate namespaced(to this module) error.
 */
export function preFlight(wsUrl: string, headers: IRawValues = {}): Promise<void> {
    let httpUrl;
    if(wsUrl.slice(0,3) === 'wss') {
        httpUrl = wsUrl.replace(/wss\:\/\//,'https://');
    } else {
        httpUrl = wsUrl.replace(/ws\:\/\//,'http://');
    }
    console.log(httpUrl);
    return fetch(httpUrl, {
        headers,
    })
    .then((res: Response) => {
        return res.text()
        .then(text => {
            if(res.status !== statusOK) {
                if (hasPreflightSucceeded(res.status, text)) {
                    return;
                }
                if (preflightErrors[res.status]) {
                    throw new preflightErrors[res.status](text,res.status);
                }
                throw new PreflightError(text, res.status);
            }
        })
        .then(() => {});
    });
}

/**
 * Determine if this preflight request has succeeded.
 */
function hasPreflightSucceeded(code: number, text: string) {
    console.log(arguments);
    return (code === statusBad && text === badMessage);
}

export * from './errors';
