import { CONNECTED_SERVICE_ERROR_CODES } from "@happier-dev/protocol";

export class ConnectedServiceOauthTimeoutError extends Error {
    constructor() {
        super("Token exchange timed out");
        this.name = "ConnectedServiceOauthTimeoutError";
    }
}

export class ConnectedServiceOauthStateMismatchError extends Error {
    constructor() {
        super("OAuth state mismatch");
        this.name = "ConnectedServiceOauthStateMismatchError";
    }
}

export type ConnectedServiceOauthExchangeErrorCode =
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthInvalidGrant
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthInvalidClient
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthMissingRefreshToken
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthProjectRequired
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthAccountIneligible;

export class ConnectedServiceOauthExchangeError extends Error {
    constructor(
        public readonly errorCode: ConnectedServiceOauthExchangeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ConnectedServiceOauthExchangeError";
    }
}
