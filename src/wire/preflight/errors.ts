import { BaseError } from '../../errors';

export class PreflightError extends BaseError {
    constructor(message: string, public code: number) {
        super(message)
    }
}

export const preflightErrors: { [code: number]: typeof PreflightError } = {};

export class BadRequestError extends PreflightError {
    constructor(message: string) {
        super(message, 400);
        BadRequestError.setProto(this);
    }
}

preflightErrors[400] = BadRequestError;

export class UnAuthorizedError extends PreflightError {
    constructor(message: string) {
        super(message, 401);
        UnAuthorizedError.setProto(this);
    }
}

preflightErrors[401] = UnAuthorizedError;

export class NotFoundError extends PreflightError {
    constructor(message: string) {
        super(message, 404);
        NotFoundError.setProto(this);
    }
}

preflightErrors[404] = NotFoundError;

export class ConflictError extends PreflightError {
    constructor(message: string) {
        super(message, 409);
        ConflictError.setProto(this);
    }
}

preflightErrors[409] = ConflictError;

export class InternalServerError extends PreflightError {
    constructor(message: string) {
        super(message, 500);
        ConflictError.setProto(this);
    }
}

preflightErrors[500] = InternalServerError;





