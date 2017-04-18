import { expect } from 'chai';

import { ConflictError, preflightErrors } from './errors';
describe('preflight errors', () => {
    it('creates errors that work with instanceof', () => {
        // This tests our prototype chain, which is easy to mess up
        const err = new ConflictError('potato');
        expect(err).to.be.an.instanceof(ConflictError);
    });
    it('performs an error lookup', () => {
        const err = new preflightErrors[409]('potato', 409);
        expect(err).to.be.an.instanceof(ConflictError);
    })
});
