import type {
  TerminalHostAdapter,
  TerminalHostKind,
  TerminalHostPreference,
} from '@happier-dev/agents';

export type {
  TerminalHostAdapter,
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

export type TerminalHostResolutionReason =
  | 'tmux_available'
  | 'tmux_forced'
  | 'tmux_unavailable'
  | 'tmux_unsupported_on_windows'
  | 'zellij_forced'
  | 'zellij_unavailable'
  | 'windows_zellij_unvalidated'
  | 'windows_arm64_unsupported'
  | 'no_host_available';

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
