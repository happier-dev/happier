export type TransferLifecycleDiagnosticContext = Readonly<{
  transferKind: 'session_file' | 'session_attachment' | 'prompt_asset' | 'prompt_registry' | 'composer_media_stage';
  archiveRequested?: boolean;
  destinationClass?: 'workspace' | 'os_temp';
}>;

export function buildTransferLifecycleDiagnosticFields(
  context: TransferLifecycleDiagnosticContext,
): TransferLifecycleDiagnosticContext {
  return {
    transferKind: context.transferKind,
    ...(typeof context.archiveRequested === 'boolean'
      ? { archiveRequested: context.archiveRequested }
      : {}),
    ...(context.destinationClass === 'workspace' || context.destinationClass === 'os_temp'
      ? { destinationClass: context.destinationClass }
      : {}),
  };
}

export function classifyTransferFailureForLog(error: unknown): 'exception' | 'non_error_throwable' {
  return error instanceof Error ? 'exception' : 'non_error_throwable';
}
