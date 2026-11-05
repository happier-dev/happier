import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export class HappyError extends Error {
    readonly canTryAgain: boolean;
    readonly status?: number;
    readonly kind?: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    readonly code?: string;
    readonly details?: unknown;
    readonly failureCause?: ActionFailureCauseV1;

    constructor(
        message: string,
        canTryAgain: boolean,
        opts?: { status?: number; kind?: 'auth' | 'config' | 'network' | 'server' | 'unknown'; code?: string; details?: unknown; failureCause?: ActionFailureCauseV1 }
    ) {
        super(message);
        this.canTryAgain = canTryAgain;
        this.status = opts?.status;
        this.kind = opts?.kind;
        this.code = opts?.code;
        this.details = opts?.details;
        if (opts?.failureCause) this.failureCause = opts.failureCause;
        this.name = 'HappyError';
        Object.setPrototypeOf(this, HappyError.prototype);
    }
}
