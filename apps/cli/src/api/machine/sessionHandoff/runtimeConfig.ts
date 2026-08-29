import { configuration } from '@/configuration';

export type SessionHandoffRuntimeConfig = Readonly<{
  activeServerDir: string;
  filesTransferSessionTtlMs?: number;
}>;

export function readSessionHandoffRuntimeConfig(): SessionHandoffRuntimeConfig {
  return {
    activeServerDir: configuration.activeServerDir,
    ...(typeof configuration.filesTransferSessionTtlMs === 'number'
      ? { filesTransferSessionTtlMs: configuration.filesTransferSessionTtlMs }
      : {}),
  };
}

export function resolveSessionHandoffTransferTimeoutMs(
  runtimeConfig: SessionHandoffRuntimeConfig,
): number | undefined {
  const timeoutMs = runtimeConfig.filesTransferSessionTtlMs;
  return typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined;
}
