import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export class HappierActionError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'HappierActionError';
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export class HappierTransportError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly failureCause?: ActionFailureCauseV1;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(message: string, options: Readonly<{
    code?: string;
    status?: number;
    failureCause?: ActionFailureCauseV1;
    details?: unknown;
    requestId?: string;
    cause?: unknown;
  }> = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HappierTransportError';
    this.code = options.code;
    this.status = options.status;
    this.failureCause = options.failureCause;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

export class HappierClientClosedError extends HappierTransportError {
  constructor(requestId?: string) {
    super('The Happier client is closed.', { requestId });
    this.name = 'HappierClientClosedError';
  }
}
