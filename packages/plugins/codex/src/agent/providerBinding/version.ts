import { parseCodexCliStableVersion } from '../cli/detect.js';

export const CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1 = Object.freeze({
  minInclusive: '0.144.0',
  maxExclusive: '0.146.1',
} as const);

export type CodexProviderBindingRuntimeVersionResultV1 =
  | Readonly<{
    ok: true;
    version: string;
  }>
  | Readonly<{
    ok: false;
    reasonCode: 'codex_provider_runtime_unsupported';
    installedVersion: string | null;
    supportedRange: typeof CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1;
    errorMessage: string;
  }>;

export function resolveCodexProviderBindingRuntimeVersionV1(
  versionOutput: string,
): CodexProviderBindingRuntimeVersionResultV1 {
  const parsed = parseCodexCliStableVersion(versionOutput);
  if (
    parsed?.major === 0
    && (
      parsed.minor === 144
      || parsed.minor === 145
      || (parsed.minor === 146 && parsed.patch === 0)
    )
  ) {
    return { ok: true, version: parsed.value };
  }

  return {
    ok: false,
    reasonCode: 'codex_provider_runtime_unsupported',
    installedVersion: parsed?.value ?? null,
    supportedRange: CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1,
    errorMessage: 'External providers require Codex CLI >=0.144.0 and <0.146.1. Update Codex or use its native model provider.',
  };
}
