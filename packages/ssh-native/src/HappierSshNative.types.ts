export type NativeSshEngine = 'russh' | 'libssh2';

export type NativeSshUnavailableReason =
  | 'unsupported-platform'
  | 'native-module-missing'
  | 'feature-disabled'
  | 'build-not-included'
  | 'engine-unavailable';

export type NativeSshAvailability =
  | Readonly<{
    available: true;
    platform: 'ios' | 'android';
    engine: NativeSshEngine;
    moduleVersion: string;
    supportsLoopbackTunnel: boolean;
    supportsPersistentHostKeyStorage: boolean;
  }>
  | Readonly<{ available: false; reason: NativeSshUnavailableReason; detail?: string }>;

export type NativeSshAuthRequest = Readonly<{
  username: string;
  password?: string;
  privateKeyPem?: string;
  privateKeyPassphrase?: string;
  privateKeyPassphraseAttempts?: number;
  keyboardInteractiveAnswers?: readonly string[];
}>;

export type NativeSshHostKeyVerification =
  | Readonly<{ decision: 'prompt' }>
  | Readonly<{ decision: 'accept-once'; fingerprintSha256: string }>
  | Readonly<{ decision: 'reject'; reason?: string }>;

export type NativeSshExecRequest = Readonly<{
  requestId: string;
  host: string;
  port: number;
  username: string;
  command: string;
  auth: NativeSshAuthRequest;
  connectTimeoutMs: number;
  authTimeoutMs: number;
  execTimeoutMs: number;
  hostKeyVerification: NativeSshHostKeyVerification;
}>;

export type NativeSshExecResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
}>;

export type NativeSshLoopbackTunnelRequest = Readonly<{
  requestId: string;
  host: string;
  port: number;
  username: string;
  auth: NativeSshAuthRequest;
  hostKeyVerification: NativeSshHostKeyVerification;
  destinationHost: '127.0.0.1' | 'localhost';
  destinationPort: number;
  requestedLocalPort?: number;
  connectTimeoutMs: number;
  authTimeoutMs: number;
}>;

export type NativeSshLoopbackTunnelResult = Readonly<{
  nativeTunnelId: string;
  localPort: number;
}>;

export type NativeSshHostKeyPromptEvent = Readonly<{
  requestId: string;
  promptId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
  status: 'unknown' | 'changed';
  existingFingerprintSha256?: string;
}>;

export type NativeSshPrivateKeyPassphrasePromptEvent = Readonly<{
  requestId: string;
  promptId: string;
  kind: 'private-key-passphrase';
  host: string;
  port: number;
  username: string;
  keyLabel?: string;
  attemptsRemaining?: number;
}>;

export type NativeSshKeyboardInteractivePromptEvent = Readonly<{
  requestId: string;
  promptId: string;
  kind: 'keyboard-interactive';
  host: string;
  port: number;
  username: string;
  name?: string;
  instruction?: string;
  prompts: ReadonlyArray<Readonly<{
    id: string;
    label: string;
    echo: boolean;
  }>>;
}>;

export type NativeSshAuthPromptEvent =
  | NativeSshPrivateKeyPassphrasePromptEvent
  | NativeSshKeyboardInteractivePromptEvent;

export type NativeSshAuthPromptResponse =
  | Readonly<{ decision: 'submit'; value: string }>
  | Readonly<{ decision: 'submit'; answers: ReadonlyArray<Readonly<{ id: string; value: string }>> }>
  | Readonly<{ decision: 'cancel'; reason?: string }>;

export type NativeSshProgressEvent = Readonly<{
  requestId: string;
  phase: 'connecting' | 'verifying-host-key' | 'authenticating' | 'executing' | 'closing';
  host: string;
  port: number;
}>;

export type NativeSshSubscription = Readonly<{
  remove: () => void;
}>;

export type NativeSshModule = Readonly<{
  getAvailability: () => NativeSshAvailability;
  exec: (request: NativeSshExecRequest) => Promise<NativeSshExecResult>;
  cancelRequest: (requestId: string) => Promise<void>;
  respondToHostKeyPrompt?: (promptId: string, response: NativeSshHostKeyVerification) => Promise<void>;
  respondToAuthPrompt?: (promptId: string, response: NativeSshAuthPromptResponse) => Promise<void>;
  startLoopbackTunnel?: (request: NativeSshLoopbackTunnelRequest) => Promise<NativeSshLoopbackTunnelResult>;
  stopLoopbackTunnel?: (nativeTunnelId: string) => Promise<void>;
  addListener?: (
    eventName: 'hostKeyPrompt' | 'authPrompt' | 'progress',
    listener: (event: NativeSshHostKeyPromptEvent | NativeSshAuthPromptEvent | NativeSshProgressEvent) => void,
  ) => NativeSshSubscription;
}>;
