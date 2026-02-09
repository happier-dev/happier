import { readFatalProviderErrorFromCliLogs } from './harnessSignals';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function isCapabilityProbeTimeout(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('operation has timed out') ||
    normalized.includes('timed out connecting user socket') ||
    normalized.includes('rpc_method_not_available') ||
    normalized.includes('rpc method not available')
  );
}

export async function enrichCapabilityProbeError(params: {
  error: unknown;
  cliHome: string;
  context: string;
}): Promise<Error> {
  const original = params.error instanceof Error ? params.error : new Error(String(params.error ?? 'unknown error'));
  const message = errorMessage(params.error);
  if (!isCapabilityProbeTimeout(message)) return original;

  const fatal = await readFatalProviderErrorFromCliLogs({ cliHome: params.cliHome });
  if (!fatal) return original;

  return new Error(`Fatal provider runtime error (${params.context}): ${fatal}`);
}
