import type {
  TerminalControlPort,
  TerminalHostKind,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalPromptInput,
  TerminalPromptWriteBoundaryV1,
} from '@happier-dev/agents';
import type { AttachSurfaceStaticMetadataV1 } from '@happier-dev/protocol';
import type { PreparedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';

export type {
  TerminalHostKind,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalPromptInput,
  TerminalPromptWriteBoundaryV1,
} from '@happier-dev/agents';

export type TerminalHostPreference = 'auto' | TerminalHostKind;

/** Failed launch admission, independent of whether host-artifact cleanup settled. */
export type TerminalHostLaunchFailure = Readonly<{
  launchDisposition: 'not_started' | 'stopped' | 'unconfirmed';
  cleanupIncomplete: boolean;
}>;

declare const terminalAttachmentIdBrand: unique symbol;

export type TerminalAttachmentId = string & Readonly<{
  [terminalAttachmentIdBrand]: 'TerminalAttachmentId';
}>;

export type TerminalHostAttachMetadata = AttachSurfaceStaticMetadataV1 & Readonly<{
  attachStrategy: 'terminal_host';
}>;

export type TerminalHostHandle = Readonly<{
  attachmentId?: TerminalAttachmentId;
  kind: TerminalHostKind;
  sessionName: string;
  paneId?: string;
  socketDir?: string;
  socketPath?: string;
  terminalId?: string;
  expectedCommandFragments?: readonly string[];
  attachMetadata: TerminalHostAttachMetadata;
}>;

export type TerminalHostCreateOrAttachOptions = Readonly<{
  /** Host namespace, distinct from a pane's display label. */
  sessionName: string;
  label?: string;
  workingDirectory: string;
  spawnArgv: readonly string[];
  spawnEnv: Readonly<Record<string, string>>;
  isolatedEnv: boolean;
  /** Optional client presentations own their pane/window, never an existing host namespace. */
  topology?: 'shared' | 'exclusive';
  /** A native invocation already owns its one-shot handoff; adapters must not wrap it again. */
  preparedLaunch?: PreparedTerminalSpawn;
}>;

export type TerminalHostLiveness = Readonly<{
  paneAlive: boolean;
  probeInconclusive?: boolean;
  paneDead?: boolean;
  panePid?: number;
  paneCurrentCommand?: string;
  /** Positive process observations only: foreground jobs are not a complete descendant census. */
  paneForegroundProcesses?: readonly Readonly<{ pid: number; argv: readonly string[] }>[];
  paneExitStatus?: number;
  paneScreenDumpCaptured?: boolean;
  paneScreenDumpTruncated?: boolean;
  paneScreenDumpError?: string;
  observedAt: number;
}>;

export type TerminalInputState = Readonly<{
  stable: boolean;
  currentInput: string;
  /** Zero-based terminal cursor position when the host can report it. */
  cursor?: Readonly<{ x: number; y: number }>;
  observedAt: number;
}>;

export type TerminalHostAdapter = Readonly<{
  kind: TerminalHostKind;
  createOrAttachHost(opts: TerminalHostCreateOrAttachOptions): Promise<TerminalHostHandle>;
  adoptExistingHost?(handle: TerminalHostHandle): Promise<TerminalHostHandle>;
  injectUserPrompt(
    handle: TerminalHostHandle,
    input: TerminalPromptInput,
    writeBoundary?: TerminalPromptWriteBoundaryV1,
  ): Promise<TerminalInputInjectionResult>;
  interruptTurn(handle: TerminalHostHandle): Promise<void>;
  evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLiveness>;
  captureInputState?(handle: TerminalHostHandle): Promise<TerminalInputState>;
  /**
   * Build a runtime-control port bound to this host handle. The port is the dedicated control surface
   * (type literal text / raw sequences / special keys, capture screen) used by the Claude Unified TUI
   * runtime-control controller. It is intentionally SEPARATE from `injectUserPrompt` (prompt delivery)
   * so runtime controls never route through the prompt-injection path. Returns `null` when the host
   * cannot provide a control target (e.g. missing pane id).
   */
  createControlPort?(handle: TerminalHostHandle): TerminalControlPort | null;
  dispose(handle: TerminalHostHandle): Promise<void>;
}>;

export type TerminalHostResolverPlatform = Readonly<{
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
}>;

export type TerminalHostResolution =
  | Readonly<{ status: 'resolved'; adapter: TerminalHostAdapter; reason: string }>
  | Readonly<{ status: 'disabled'; reason: string; message: string }>;
