import type {
  BrowserCommandDispatchResultV1,
  BrowserCommandErrorCodeV1,
  BrowserCommandV1,
  BrowserDaemonViewV1,
  BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

export type BrowserCommandScope = Readonly<{
  signal?: AbortSignal;
  /** Containing operation's absolute deadline, in Date.now() milliseconds. */
  deadlineMs?: number;
  requester?: Readonly<{
    actorAccountId?: string;
    custodianAccountId?: string;
    role?: NonNullable<RpcActionExecutorContext['machineAdmission']>['role'];
  }>;
}>;

/** Carry admitted custody to profile selection without forwarding credentials to CDP. */
export function browserCommandScope(context?: Pick<RpcActionExecutorContext,
  'signal' | 'externalActionExecutionAuthorization' | 'machineAdmission' | 'requesterSessionBootstrap'>): BrowserCommandScope {
  const requester = readRequesterAccountActionContext(context?.externalActionExecutionAuthorization);
  const admission = context?.machineAdmission
    ?? context?.requesterSessionBootstrap?.savedSecretOperationContext.machineAdmission
    ?? requester?.savedSecretOperationContext.machineAdmission;
  return { signal: context?.signal,
    ...(admission || context?.requesterSessionBootstrap || requester ? { requester: {
      actorAccountId: admission?.actorAccountId ?? context?.requesterSessionBootstrap?.attribution.accountId,
      custodianAccountId: admission?.custodianAccountId,
      role: admission?.role,
    } } : {}) };
}

export type BrowserDaemonControlAdapterKind = Extract<
  BrowserSemanticAdapterKindV1,
  'chromiumSidecar' | 'streamedBrowserSurface'
>;

const BROWSER_DAEMON_CONTROL_ADAPTER_KINDS = new Set<string>([
  'chromiumSidecar',
  'streamedBrowserSurface',
]);

export function isBrowserDaemonControlAdapterKind(input: unknown): input is BrowserDaemonControlAdapterKind {
  return typeof input === 'string' && BROWSER_DAEMON_CONTROL_ADAPTER_KINDS.has(input);
}

export type BrowserDaemonControlViewIdentity = Readonly<{
  browserSessionId: string;
  viewId: string;
}>;

/** Session-owned Actions need profile custody without manufacturing a control command. */
export type BrowserExistingProfile = Readonly<{
  profileId?: string;
  adapterKind: BrowserSemanticAdapterKindV1;
}>;

export type BrowserCommandAccessTarget = BrowserCommandV1 | Readonly<{
  commandId: string;
  browserSessionId: string;
  /** Captured provenance, distinct from selecting a profile for a new view. */
  existingProfile?: BrowserExistingProfile;
}>;

export type BrowserDaemonViewWatch = Readonly<{
  browserSessionId: string;
  knownViewIds: readonly string[];
  signal?: AbortSignal;
  scope?: BrowserCommandScope;
}>;

export type BrowserDaemonControlAdapter = Readonly<{
  adapterKind: BrowserDaemonControlAdapterKind;
  ownsView(input: BrowserDaemonControlViewIdentity): boolean;
  listViews?(browserSessionId: string, scope?: BrowserCommandScope): readonly BrowserDaemonViewV1[];
  /** Profile custody also governs controller effects executed outside native dispatch. */
  getCommandAccessFailure?(command: BrowserCommandAccessTarget, scope?: BrowserCommandScope): Extract<BrowserCommandDispatchResultV1, { status: 'failed' }> | undefined;
  subscribeViewLifecycle?(listener: (event: BrowserDaemonControlViewIdentity) => void): () => void;
  supportsOpenView(command: Extract<BrowserCommandV1, { kind: 'openView' }>): boolean;
  dispatchCommand(command: BrowserCommandV1, scope?: BrowserCommandScope): Promise<BrowserCommandDispatchResultV1> | BrowserCommandDispatchResultV1;
}>;

export type BrowserDaemonControlBroker = Readonly<{
  registerAdapter(adapter: BrowserDaemonControlAdapter): () => void;
  ownsView(input: BrowserDaemonControlViewIdentity): boolean;
  dispatchCommand(command: BrowserCommandV1, scope?: BrowserCommandScope): Promise<BrowserCommandDispatchResultV1>;
  hasExecutableAdapters(): boolean;
  listViews(browserSessionId: string, scope?: BrowserCommandScope): readonly BrowserDaemonViewV1[];
  getCommandAccessFailure(command: BrowserCommandAccessTarget, scope?: BrowserCommandScope): Extract<BrowserCommandDispatchResultV1, { status: 'failed' }> | undefined;
  watchViews(input: BrowserDaemonViewWatch): Promise<void>;
}>;

export function browserCommandDispatchFailure(
  input: Readonly<{
    commandId: string;
    code: BrowserCommandErrorCodeV1;
    message: string;
    adapterKind?: BrowserDaemonControlAdapterKind;
    retryable?: boolean;
    completion?: 'known' | 'unknown';
  }>,
): Extract<BrowserCommandDispatchResultV1, { status: 'failed' }> {
  return {
    v: 1,
    commandId: input.commandId,
    status: 'failed',
    ...(input.adapterKind ? { adapterKind: input.adapterKind } : {}),
    ...(input.completion ? { completion: input.completion } : {}),
    error: {
      code: input.code,
      message: input.message,
      ...(typeof input.retryable === 'boolean' ? { retryable: input.retryable } : {}),
    },
  };
}

/** Missing transport provenance cannot establish that Chromium did not apply an effect. */
export function classifyBrowserCommandCompletion(result: BrowserCommandDispatchResultV1): 'known' | 'unknown' {
  if (result.status === 'dispatched') return 'known';
  if (result.completion) return result.completion;
  return result.error.code === 'view_not_found' || result.error.code === 'unsupported_command' ? 'known' : 'unknown';
}
