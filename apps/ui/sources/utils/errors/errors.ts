export class HappyError extends Error {
    readonly canTryAgain: boolean;
    readonly status?: number;
    readonly kind?: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    readonly code?: string;
    readonly details?: unknown;

    constructor(
        message: string,
        canTryAgain: boolean,
        opts?: { status?: number; kind?: 'auth' | 'config' | 'network' | 'server' | 'unknown'; code?: string; details?: unknown }
    ) {
        super(message);
        this.canTryAgain = canTryAgain;
        this.status = opts?.status;
        this.kind = opts?.kind;
        this.code = opts?.code;
        this.details = opts?.details;
        this.name = 'HappyError';
        Object.setPrototypeOf(this, HappyError.prototype);
    }
}
