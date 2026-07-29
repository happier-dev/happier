export type PluginsDevPlatformEvidence = Readonly<{
  runtimePlatform: 'darwin' | 'linux' | 'win32';
  evidencePlatform: 'macos' | 'linux' | 'windows';
  scenario: string;
  runLabel: string;
  qaLabel: string;
}>;

const EVIDENCE_PLATFORM_BY_RUNTIME = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
} as const;

export function resolvePluginsDevPlatform(runtimePlatform: string): PluginsDevPlatformEvidence {
  const evidencePlatform = EVIDENCE_PLATFORM_BY_RUNTIME[
    runtimePlatform as keyof typeof EVIDENCE_PLATFORM_BY_RUNTIME
  ];
  if (!evidencePlatform) {
    throw new Error(
      `The packed plugins dev live recipe supports only darwin, linux, and win32; current platform is ${runtimePlatform}`,
    );
  }

  const supportedRuntimePlatform = runtimePlatform as keyof typeof EVIDENCE_PLATFORM_BY_RUNTIME;
  return {
    runtimePlatform: supportedRuntimePlatform,
    evidencePlatform,
    scenario: `plugins-dev-${evidencePlatform}-live`,
    runLabel: `plugins-dev-${evidencePlatform}`,
    qaLabel: `QA-005-${evidencePlatform}`,
  };
}
