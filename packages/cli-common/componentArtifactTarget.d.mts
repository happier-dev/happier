export declare function getComponentArtifactBuildTargetUnavailableReason(params: Readonly<{
  components: Readonly<{ web?: boolean; server?: boolean; daemon?: boolean }>;
  target: Readonly<{ os: string; arch: string }>;
  platform?: string;
  arch?: string;
  commandProbe?: (command: string) => boolean;
}>): string | null;

export declare function getCliBinaryArtifactSupportTargetUnavailableReason(params: Readonly<{
  target: Readonly<{ os: string; arch: string }>;
  platform?: string;
  arch?: string;
  commandProbe?: (command: string) => boolean;
}>): string | null;
