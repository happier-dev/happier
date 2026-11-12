import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export class HappyError extends Error {
    readonly canTryAgain: boolean;
    readonly status?: number;
    readonly kind?: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    readonly code?: string;
    readonly details?: unknown;
    readonly failureCause?: ActionFailureCauseV1;
    readonly effectAttempted?: boolean;
    /** The Action request this failure answered, for support (Details), never prose. */
    readonly requestId?: string;

    constructor(
        message: string,
        canTryAgain: boolean,
        opts?: { status?: number; kind?: 'auth' | 'config' | 'network' | 'server' | 'unknown'; code?: string; details?: unknown; failureCause?: ActionFailureCauseV1; effectAttempted?: boolean; requestId?: string }
    ) {
        super(message);
        this.canTryAgain = canTryAgain;
        this.status = opts?.status;
        this.kind = opts?.kind;
        this.code = opts?.code;
        this.details = opts?.details;
        if (opts?.failureCause) this.failureCause = opts.failureCause;
        if (opts?.effectAttempted !== undefined) this.effectAttempted = opts.effectAttempted;
        if (opts?.requestId) this.requestId = opts.requestId;
        this.name = 'HappyError';
        Object.setPrototypeOf(this, HappyError.prototype);
    }
}
