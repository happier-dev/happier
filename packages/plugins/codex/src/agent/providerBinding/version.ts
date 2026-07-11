export const CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1 = Object.freeze({
  minInclusive: '0.144.0',
  maxExclusive: '0.145.0',
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

function readStableReleaseVersion(output: string): Readonly<{
  major: number;
  minor: number;
  patch: number;
  value: string;
}> | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  const patch = Number.parseInt(match[3] ?? '', 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, value: `${major}.${minor}.${patch}` };
}

export function resolveCodexProviderBindingRuntimeVersionV1(
  versionOutput: string,
): CodexProviderBindingRuntimeVersionResultV1 {
  const parsed = readStableReleaseVersion(versionOutput);
  if (parsed?.major === 0 && parsed.minor === 144) {
    return { ok: true, version: parsed.value };
  }

  return {
    ok: false,
    reasonCode: 'codex_provider_runtime_unsupported',
    installedVersion: parsed?.value ?? null,
    supportedRange: CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1,
    errorMessage: 'External providers require Codex CLI >=0.144.0 and <0.145.0. Update Codex or use its native model provider.',
  };
}
