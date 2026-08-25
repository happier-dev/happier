export type TerminalNativePlatform = 'ios' | 'android';

export type TerminalNativeRuntimePlatform = TerminalNativePlatform | 'web' | 'desktop' | 'unknown';

export type TerminalNativeRenderer =
  | 'ios-ghosttykit'
  | 'android-termux';

export type TerminalNativeAccessibility =
  | 'native'
  | 'fallback-required';

export type TerminalNativeUnavailableReason =
  | 'unsupported-platform'
  | 'native-module-missing'
  | 'feature-disabled'
  | 'build-not-included'
  | 'legal-not-approved'
  | 'dependency-closure-unapproved'
  | 'package-proof-unaccepted'
  | 'artifact-missing'
  | 'abi-unsupported'
  | 'renderer-unavailable'
  | 'surface-not-ready'
  | 'accessibility-unproven';

export type TerminalNativeWriteRejectionReason =
  | 'surface-not-ready'
  | 'renderer-unavailable'
  | 'queue-full'
  | 'invalid-ack';

export type TerminalNativeAvailability =
  | Readonly<{
    available: true;
    platform: TerminalNativePlatform;
    renderer: TerminalNativeRenderer;
    moduleVersion: string;
    accessibility: TerminalNativeAccessibility;
  }>
  | Readonly<{ available: false; reason: TerminalNativeUnavailableReason; detail?: string }>;

export type TerminalNativeEventName =
  | 'rendererCrash'
  | 'surfaceReady'
  | 'writeAck'
  | 'input'
  | 'resize'
  | 'link'
  | 'selection'
  | 'copy'
  | 'title'
  | 'bell';

export type TerminalNativeRendererCrashEvent = Readonly<{
  surfaceId: string;
  reason: string;
  fatal: true;
}>;

export type TerminalNativeSurfaceReadyEvent = Readonly<{
  surfaceId: string;
  cols: number;
  rows: number;
}>;

export type TerminalNativeWriteAckEvent = Readonly<{
  surfaceId: string;
  byteOffset: number;
}>;

export type TerminalNativeInputEvent = Readonly<{
  surfaceId: string;
  data: string;
}>;

export type TerminalNativeResizeEvent = Readonly<{
  surfaceId: string;
  cols: number;
  rows: number;
}>;

export type TerminalNativeLinkEvent = Readonly<{
  surfaceId: string;
  url: string;
  text?: string;
}>;

export type TerminalNativeSelectionState =
  | 'started'
  | 'changed'
  | 'ended'
  | 'cleared'
  | 'copied';

export type TerminalNativeSelectionEvent = Readonly<{
  surfaceId: string;
  state: TerminalNativeSelectionState;
  text?: string;
}>;

export type TerminalNativeCopyEvent = Readonly<{
  surfaceId: string;
  text: string;
}>;

export type TerminalNativeTitleEvent = Readonly<{
  surfaceId: string;
  title: string;
}>;

export type TerminalNativeBellEvent = Readonly<{
  surfaceId: string;
  label?: string;
}>;

export type TerminalNativeEventPayloadMap = Readonly<{
  rendererCrash: TerminalNativeRendererCrashEvent;
  surfaceReady: TerminalNativeSurfaceReadyEvent;
  writeAck: TerminalNativeWriteAckEvent;
  input: TerminalNativeInputEvent;
  resize: TerminalNativeResizeEvent;
  link: TerminalNativeLinkEvent;
  selection: TerminalNativeSelectionEvent;
  copy: TerminalNativeCopyEvent;
  title: TerminalNativeTitleEvent;
  bell: TerminalNativeBellEvent;
}>;

export type TerminalNativeEventPayload<TName extends TerminalNativeEventName> =
  TerminalNativeEventPayloadMap[TName];

export type TerminalNativeEventSubscription = Readonly<{
  remove: () => void;
}>;

export type TerminalNativeModule = Readonly<{
  getAvailability: () => TerminalNativeAvailability;
  createSurface?: (surfaceId: string) => Promise<unknown> | unknown;
  writeBytes?: (surfaceId: string, base64Bytes: string, byteOffset: number) => Promise<unknown> | unknown;
  resizeSurface?: (surfaceId: string, cols: number, rows: number) => Promise<void> | void;
  focusSurface?: (surfaceId: string) => Promise<void> | void;
  clearSurface?: (surfaceId: string) => Promise<void> | void;
  disposeSurface?: (surfaceId: string) => Promise<void> | void;
  copySelection?: (surfaceId: string) => Promise<unknown> | unknown;
  addListener?: <TName extends TerminalNativeEventName>(
    eventName: TName,
    listener: (event: TerminalNativeEventPayload<TName>) => void,
  ) => TerminalNativeEventSubscription;
}>;
