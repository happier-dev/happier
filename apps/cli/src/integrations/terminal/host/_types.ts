import type {
  TerminalHostAdapter as AgentTerminalHostAdapter,
  TerminalHostKind,
  TerminalHostHandle,
  TerminalHostPreference,
} from '@happier-dev/agents';
import type { AgentTerminalHostResolutionReason } from '@happier-dev/plugin-sdk/agents/runtime';
import type { TerminalLaunchSpec } from '@/terminal/host/launchSpec';

export type TerminalHostNativeLaunch = Readonly<{
  workingDirectory: string;
  spawnArgv: readonly string[];
  spawnEnv: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
  isolatedEnv: boolean;
  windowsVerbatimArguments?: boolean;
}>;

export type TerminalHostProcessObservation = Readonly<{ pid: number; argv: readonly string[] }>;

/** Host-private prepared native invocation; never exposed through the plugin SDK. */
export type TerminalHostAdapter = Omit<AgentTerminalHostAdapter, 'createOrAttachHost'> & Readonly<{
  /** Positive observations only: missing processes never prove native exit. */
  captureProcessObservations?(handle: TerminalHostHandle): Promise<readonly TerminalHostProcessObservation[] | null>;
  createOrAttachHost(opts: Parameters<AgentTerminalHostAdapter['createOrAttachHost']>[0] & Readonly<{
    preparedLaunch?: TerminalLaunchSpec;
    /** Host-only final authorization, invoked only when a new process is required. */
    prepareLaunch?(): Promise<TerminalHostNativeLaunch>;
    windowsVerbatimArguments?: boolean;
  }>): ReturnType<AgentTerminalHostAdapter['createOrAttachHost']>;
}>;

export type {
  TerminalHostAttachMetadata,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostPreference,
  TerminalInputState,
} from '@happier-dev/agents';

export type TerminalHostResolverPlatform = Readonly<{
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
}>;

export type TerminalHostResolutionReason = AgentTerminalHostResolutionReason;

export type TerminalHostResolution =
  | Readonly<{
      status: 'resolved';
      adapter: TerminalHostAdapter;
      reason: TerminalHostResolutionReason;
    }>
  | Readonly<{
      status: 'disabled';
      reason: TerminalHostResolutionReason;
      message: string;
    }>;

export type ResolveTerminalHostParams = Readonly<{
  preference: TerminalHostPreference;
  platform: TerminalHostResolverPlatform;
  adapters: Readonly<Partial<Record<TerminalHostKind, TerminalHostAdapter>>>;
  tmuxAvailable: boolean;
  zellijAvailable: boolean;
}>;
