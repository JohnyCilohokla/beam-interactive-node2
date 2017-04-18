import { expect } from 'chai';

import { InteractiveError } from './errors';
describe('interactive errors', () => {
    it('creates expected error from socket message', () => {
        const err = new InteractiveError.InvalidPayload('potato');
        expect(err).to.be.an.instanceof(InteractiveError.InvalidPayload);
    });
    it('performs an error lookup', () => {
        const err = InteractiveError.fromSocketMessage({code:4000, message: 'test'});
        expect(err).to.be.an.instanceof(InteractiveError.InvalidPayload);
    })
});
