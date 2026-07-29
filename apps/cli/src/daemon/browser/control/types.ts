import type {
  BrowserCommandDispatchResultV1,
  BrowserCommandErrorCodeV1,
  BrowserCommandV1,
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
  supportsOpenView(command: Extract<BrowserCommandV1, { kind: 'openView' }>): boolean;
  dispatchCommand(command: BrowserCommandV1): Promise<BrowserCommandDispatchResultV1> | BrowserCommandDispatchResultV1;
}>;

export type BrowserDaemonControlBroker = Readonly<{
  registerAdapter(adapter: BrowserDaemonControlAdapter): () => void;
  dispatchCommand(command: BrowserCommandV1): Promise<BrowserCommandDispatchResultV1>;
  hasExecutableAdapters(): boolean;
}>;

export function browserCommandDispatchFailure(
  input: Readonly<{
    commandId: string;
    code: BrowserCommandErrorCodeV1;
    message: string;
    adapterKind?: BrowserDaemonControlAdapterKind;
    retryable?: boolean;
  }>,
): BrowserCommandDispatchResultV1 {
  return {
    v: 1,
    commandId: input.commandId,
    status: 'failed',
    ...(input.adapterKind ? { adapterKind: input.adapterKind } : {}),
    error: {
      code: input.code,
      message: input.message,
      ...(typeof input.retryable === 'boolean' ? { retryable: input.retryable } : {}),
    },
  };
}
