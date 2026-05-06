export type NativeSshEngine = 'russh' | 'libssh2';

export type NativeSshUnavailableReason =
  | 'unsupported-platform'
  | 'native-module-missing'
  | 'feature-disabled'
  | 'build-not-included'
  | 'engine-unavailable';

export type NativeSshAvailability =
  | Readonly<{ available: true; platform: 'ios' | 'android'; engine: NativeSshEngine; moduleVersion: string }>
  | Readonly<{ available: false; reason: NativeSshUnavailableReason; detail?: string }>;

export type NativeSshAuthRequest = Readonly<{
  username: string;
  password?: string;
  privateKeyPem?: string;
  privateKeyPassphrase?: string;
  keyboardInteractiveAnswers?: readonly string[];
}>;

export type NativeSshHostKeyVerification =
  | Readonly<{ decision: 'accept-once'; fingerprintSha256: string }>
  | Readonly<{ decision: 'accept-and-store'; fingerprintSha256: string }>
  | Readonly<{ decision: 'reject'; reason?: string }>;

export type NativeSshExecRequest = Readonly<{
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

export type NativeSshHostKeyPromptEvent = Readonly<{
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
}>;

export type NativeSshProgressEvent = Readonly<{
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
  addListener?: (
    eventName: 'hostKeyPrompt' | 'progress',
    listener: (event: NativeSshHostKeyPromptEvent | NativeSshProgressEvent) => void,
  ) => NativeSshSubscription;
}>;
