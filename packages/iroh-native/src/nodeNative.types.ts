/**
 * Node/Bun lifecycle binding contracts over the `happier-iroh-native` JSON C
 * ABI. Lifecycle/status only: requests and responses are validated JSON
 * envelopes; tunnel payload bytes never cross this boundary and there is no
 * generic dispatch operation — one typed function per C ABI export.
 */
import type { NativeIrohModule } from './HappierIrohNative.types.js';
import type { IrohObservedPath, IrohRelayPolicy } from './types.js';

/** Fixed machine-carrier admission/framing metadata shared with daemon composition. */
export {
  MACHINE_ADMISSION_PATH as IROH_MACHINE_ADMISSION_PATH,
  MACHINE_APPLICATION_CAPABILITY_HEADER as IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
  MACHINE_APPLICATION_PORT_HEADER as IROH_MACHINE_APPLICATION_PORT_HEADER,
  MACHINE_REMOTE_ENDPOINT_HEADER as IROH_MACHINE_REMOTE_ENDPOINT_HEADER,
  MACHINE_STREAM_ACCEPT_BYTE as IROH_MACHINE_STREAM_ACCEPT_BYTE,
  MACHINE_STREAM_REJECT_BYTE as IROH_MACHINE_STREAM_REJECT_BYTE,
} from './descriptor.js';

/** Cap profile ids accepted by the C ABI (`IrohCapProfile`). */
export type IrohNodeCapProfile = 'homeInteractive' | 'machineBulk';

/** Every export the Node/Bun addon must expose (the exact no-payload allowlist). */
export const IROH_NODE_NATIVE_EXPORTS = [
  'getAvailability',
  'createEndpoint',
  'startHomeAcceptor',
  'stopHomeAcceptor',
  'ensureHomeTunnel',
  'releaseHomeTunnel',
  'shutdownEndpoint',
  'getEndpointStatus',
  'getTunnelStatus',
  'startMachineAcceptor',
  'stopMachineAcceptor',
  'getMachineAcceptorStatus',
  'startMachineTunnel',
  'startMachineHttpTunnel',
  'stopMachineTunnel',
  'getMachineTunnelStatus',
  'waitMachineTunnelClosed',
] as const;

export type IrohNodeNativeExportName = (typeof IROH_NODE_NATIVE_EXPORTS)[number];

/** Availability/status metadata reported by the addon (`getAvailability`). */
export type IrohNodeAvailability = Readonly<{
  available: boolean;
  os: string;
  arch: string;
  engine: string;
  surface: readonly string[];
}>;

/** Raw `.node` addon surface: one JSON-string request per C ABI operation. */
export type IrohNodeNativeAddon = Readonly<{
  /** Optional host allocator maintenance, outside the Iroh lifecycle ABI. */
  trimProcessAllocator?: () => Promise<boolean>;
  /** Optional on older addons; absence only disables guest-preview observation. */
  waitMachineTunnelClosed?: (request: string) => Promise<string>;
  getAvailability: () => IrohNodeAvailability;
  startMachineHttpTunnel: (
    request: string,
    handshakeProvider?: () => Promise<string>,
  ) => Promise<string>;
}> & {
  [Name in Exclude<IrohNodeNativeExportName, 'getAvailability' | 'startMachineHttpTunnel' | 'waitMachineTunnelClosed'>]: (
    request: string,
  ) => Promise<string>;
};

export type IrohNodeCreateEndpointRequest = Readonly<{
  keyPath?: string;
  relayPolicy?: IrohRelayPolicy;
  relayUrls?: readonly string[];
  capProfile?: IrohNodeCapProfile;
}>;

export type IrohNodeStartHomeAcceptorRequest = Readonly<{
  endpointHandle: string;
  targetHost?: string;
  targetPort: number;
}>;

export type IrohNodeEndpointHandleRequest = Readonly<{ endpointHandle: string }>;

/**
 * The acceptor owns only its fixed local admission target: the application
 * host is hard-coded loopback in Rust and the per-stream application port is
 * selected by the trusted local admission response, never by an input.
 */
export type IrohNodeStartMachineAcceptorRequest = Readonly<{
  endpointHandle: string;
  admissionHost?: string;
  admissionPort: number;
}>;

export type IrohNodeStartMachineTunnelRequest = Readonly<{
  endpointHandle: string;
  endpointId: string;
  directAddresses?: readonly string[];
  relayUrls?: readonly string[];
  handshakeJson: string;
  capProfile?: Extract<IrohNodeCapProfile, 'machineBulk'>;
  /** The native core consumes this signed open; guests only receive localPort. */
  nativeHttpLease?: Readonly<{ openJson: string }>;
}>;

/** Trusted local callback outcome; serialized as JSON, never sent to the peer. */
export type IrohNodeMachineHttpHandshakeRefusal = Readonly<{
  kind: 'http_refusal';
  /** JSON serialized by the application admission owner and returned as HTTP 403. */
  responseBody: string;
}>;

export type IrohNodeStartMachineHttpTunnelRequest = IrohNodeStartMachineTunnelRequest & Readonly<{
  /**
   * Called once for each authenticated local HTTP connection, before its QUIC
   * stream opens. Resolves to a handshake or JSON-serialized local HTTP refusal.
   */
  handshakeProvider?: () => Promise<string>;
}>;

export type IrohNodeEnsureHomeTunnelRequest = Readonly<{
  endpointHandle: string;
  homeServerIdentityId: string;
  endpointId: string;
  directAddresses?: readonly string[];
  relayUrls?: readonly string[];
}>;

/**
 * Legacy mobile trio start request. Mirrors the shared `NativeIrohModule`
 * request shape exactly (including `capProfile?: string`) so the Node module
 * stays structurally assignable to that shared surface.
 */
/** Status object of a running Home acceptor (`HomeAcceptorStatus`). */
export type IrohNodeAcceptorStatus = Readonly<{
  running: boolean;
  connectionsAccepted: number;
  connectionsActive: number;
  streamsAccepted: number;
  /** Machine acceptors report currently admitted application streams. */
  streamsActive?: number;
  streamsRejected: number;
  lastPath: Readonly<{
    observedPath: IrohObservedPath;
    isRelay: boolean;
    remoteEndpointId: string;
    atMs: number;
  }> | null;
  /** Machine acceptors populate this with the last rejected stream category. */
  lastErrorCode?: IrohNodeMachineFailureCode | null;
}>;

export type IrohNodeMachineFailureCode =
  | 'invalid-preamble'
  | 'machine-control-invalid'
  | 'machine-admission-rejected'
  | 'endpoint-identity-mismatch'
  | 'transport-unavailable'
  // Host-private status categories. These never change the stream decision byte.
  | 'machine-admission-timeout'
  | 'local-http-head-timeout'
  | 'local-capability-timeout'
  | 'local-capability-rejected'
  | 'machine-stream-decision-timeout'
  | 'machine-stream-decision-closed'
  | 'no-application-stream';

export type IrohNodeAcceptorStarted = Readonly<{
  endpointHandle: string;
  reused: boolean;
  status: IrohNodeAcceptorStatus;
}>;

export type IrohNodeMachineTunnelStarted = Readonly<{
  machineTunnelId: string;
  endpointHandle: string;
  localPort: number;
  /**
   * Per-listener local capability consumed natively before application bytes.
   * Finite transfers intentionally omit it because their prepared-transfer
   * authority is enforced at the fixed admitted target.
   */
  localCapability?: string;
  connectionActive: boolean;
  /** Normalized authenticated remote endpoint identity this tunnel dials. */
  remoteEndpointId: string;
  observedPath: IrohObservedPath;
  startedAtMs: number;
  lastErrorCode: IrohNodeMachineFailureCode | null;
}>;

export type IrohNodeMachineHttpTunnelStarted = Readonly<
  Omit<IrohNodeMachineTunnelStarted, 'localCapability'> & { localCapability: string }
>;

export type IrohNodeMachineTunnelStatus = Readonly<{
  machineTunnelId: string;
  endpointHandle: string;
  localPort: number;
  connectionActive: boolean;
  remoteEndpointId: string;
  observedPath: IrohObservedPath;
  startedAtMs: number;
  lastErrorCode: IrohNodeMachineFailureCode | null;
  streamsOpened: number;
}>;

export type IrohNodeEndpointCreated = Readonly<{
  endpointHandle: string;
  endpointId: string;
  relayPolicy: 'automatic' | 'disabled';
  relayMode: 'disabled' | 'custom';
  /** Incoming-service default; outgoing connections apply their own profile. */
  capProfile: string;
  relayUrls: readonly string[];
}>;

export type IrohNodeEndpointStatus = Readonly<{
  endpointHandle: string;
  endpointId: string;
  relayPolicy: 'automatic' | 'disabled';
  relayMode: string;
  relayUrls: readonly string[];
  /** Incoming-service default; outgoing connections apply their own profile. */
  capProfile: string;
  directAddresses: readonly string[];
  active: boolean;
}>;

export type IrohNodeTunnelStarted = Readonly<{
  tunnelId: string;
  homeServerIdentityId: string;
  homeEndpointId: string;
  runtimeOrigin: string;
  carrier: 'iroh';
  observedPath: IrohObservedPath;
  startedAtMs: number;
  endpointHandle: string;
}>;

export type IrohNodeTunnelStatus = Readonly<{
  tunnelId: string;
  homeServerIdentityId: string;
  runtimeOrigin: string;
  carrier: 'iroh';
  observedPath: IrohObservedPath;
  connectionActive: boolean;
  streamsOpened: number;
  startedAtMs: number;
  endpointHandle: string;
}>;

/**
 * Typed async lifecycle surface exposed to Node/Bun callers. Structurally
 * assignable to the shared `NativeIrohModule` (see
 * `NodeIrohNativeModuleSatisfiesSharedSurface`), so server composition can
 * reuse the mobile seam owners unchanged.
 */
export type NodeIrohNativeModule = Readonly<{
  getAvailability: () => IrohNodeAvailability;
  createEndpoint: (request: IrohNodeCreateEndpointRequest) => Promise<IrohNodeEndpointCreated>;
  startHomeAcceptor: (request: IrohNodeStartHomeAcceptorRequest) => Promise<IrohNodeAcceptorStarted>;
  stopHomeAcceptor: (request: IrohNodeEndpointHandleRequest) => Promise<void>;
  ensureHomeTunnel: (request: IrohNodeEnsureHomeTunnelRequest) => Promise<IrohNodeTunnelStarted>;
  releaseHomeTunnel: (tunnelId: string) => Promise<void>;
  shutdownEndpoint: (request: IrohNodeEndpointHandleRequest) => Promise<void>;
  getEndpointStatus: (endpointHandle: string) => Promise<IrohNodeEndpointStatus | null>;
  getTunnelStatus: (tunnelId: string) => Promise<IrohNodeTunnelStatus | null>;
  startMachineAcceptor: (request: IrohNodeStartMachineAcceptorRequest) => Promise<IrohNodeAcceptorStarted>;
  stopMachineAcceptor: (request: IrohNodeEndpointHandleRequest) => Promise<void>;
  getMachineAcceptorStatus: (endpointHandle: string) => Promise<IrohNodeAcceptorStatus | null>;
  startMachineTunnel: (request: IrohNodeStartMachineTunnelRequest) => Promise<IrohNodeMachineTunnelStarted>;
  startMachineHttpTunnel: (request: IrohNodeStartMachineHttpTunnelRequest) => Promise<IrohNodeMachineHttpTunnelStarted>;
  stopMachineTunnel: (machineTunnelId: string) => Promise<void>;
  getMachineTunnelStatus: (machineTunnelId: string) => Promise<IrohNodeMachineTunnelStatus | null>;
  waitMachineTunnelClosed?: (machineTunnelId: string) => Promise<void>;
}>;

/**
 * Compile-time proof that the Node module satisfies the shared native module
 * surface used by the mobile/desktop adapter owners.
 */
export type NodeIrohNativeModuleSatisfiesSharedSurface =
  NodeIrohNativeModule extends NativeIrohModule ? true : never;

/**
 * Typed loader outcome: `native_unavailable` when no target addon exists —
 * never a silent fallback to an unrelated binary.
 */
export type LoadIrohNodeNativeResult = Readonly<
  | { available: true; native: NodeIrohNativeModule; addonPath: string }
  | {
      available: false;
      reason: 'native_unavailable';
      message: string;
      addonPath: string | null;
    }
>;
