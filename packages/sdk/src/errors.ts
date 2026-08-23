export class HappierActionError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HappierActionError';
    this.code = code;
    this.details = details;
  }
}

export class HappierTransportError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, options: Readonly<{
    code?: string;
    status?: number;
    details?: unknown;
    cause?: unknown;
  }> = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HappierTransportError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export class HappierClientClosedError extends HappierTransportError {
  constructor() {
    super('The Happier client is closed.');
    this.name = 'HappierClientClosedError';
  }
}
