import type { CliAcquisitionPhase, CliAcquisitionProgress } from '@happier-dev/protocol';

export type FirstPartyAcquisitionOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: CliAcquisitionProgress) => void;
  /** Optional cleanup could not complete; defaults to a visible warning on stderr. */
  onWarning?: (message: string) => void;
}>;

/** Keep diagnostic context without exposing signed download URLs or URL credentials. */
export function redactAcquisitionDiagnostic(message: string): string {
  return message.replace(/https?:\/\/[^\s]+/gu, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '[release URL]';
    }
  });
}

export class FirstPartyAcquisitionError extends Error {
  constructor(
    readonly phase: CliAcquisitionPhase,
    readonly failureCause: string,
    error: unknown,
  ) {
    super(redactAcquisitionDiagnostic(error instanceof Error ? error.message : String(error)));
    this.name = 'FirstPartyAcquisitionError';
  }
}

export function readAcquisitionFailureCause(error: unknown): string {
  if (error instanceof Error && error.cause) return readAcquisitionFailureCause(error.cause);
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return /^[a-z0-9_-]+$/iu.test(error.code) ? error.code : 'unknown';
  }
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    return `HTTP_${error.status}`;
  }
  return error instanceof Error ? error.name : 'unknown';
}
