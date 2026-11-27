/** The provider process ended on its own (non-zero exit or a signal such as an OS/OOM stop), not by a provider-reported error. */
export class ProviderProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: string | null;

  constructor(params: Readonly<{ exitCode: number | null; signal: string | null }>) {
    super(params.signal ? `Signal: ${params.signal}` : `Exit code: ${params.exitCode ?? 1}`);
    this.name = 'ProviderProcessExitError';
    this.exitCode = params.exitCode;
    this.signal = params.signal;
  }
}
