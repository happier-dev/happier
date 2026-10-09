import type {
  BrowserCommandDispatchResultV1,
  BrowserCommandErrorCodeV1,
  BrowserCommandV1,
  BrowserDaemonViewV1,
  BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol';

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

export type BrowserDaemonControlAdapter = Readonly<{
  adapterKind: BrowserDaemonControlAdapterKind;
  ownsView(input: BrowserDaemonControlViewIdentity): boolean;
  listViews?(browserSessionId: string): readonly BrowserDaemonViewV1[];
  supportsOpenView(command: Extract<BrowserCommandV1, { kind: 'openView' }>): boolean;
  dispatchCommand(command: BrowserCommandV1, scope?: Readonly<{ signal?: AbortSignal; deadlineMs?: number }>): Promise<BrowserCommandDispatchResultV1> | BrowserCommandDispatchResultV1;
}>;

export type BrowserDaemonControlBroker = Readonly<{
  registerAdapter(adapter: BrowserDaemonControlAdapter): () => void;
  ownsView(input: BrowserDaemonControlViewIdentity): boolean;
  dispatchCommand(command: BrowserCommandV1): Promise<BrowserCommandDispatchResultV1>;
  hasExecutableAdapters(): boolean;
  listViews(browserSessionId: string): readonly BrowserDaemonViewV1[];
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
): BrowserCommandDispatchResultV1 {
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
