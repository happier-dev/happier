/**
 * Node/Bun loader and typed module for the Iroh lifecycle addon (stable
 * public export for the server: `@happier-dev/iroh-native/node`).
 *
 * Loader behavior:
 * - the artifact is resolved deterministically as
 *   `<packageRoot>/native/happier-iroh-native-lifecycle.<platform>-<arch>.node`;
 * - a missing artifact, an unsupported platform/arch pair, or a file that does
 *   not expose the full lifecycle surface is a typed
 *   `{ available: false, reason: 'native_unavailable' }` result — never a
 *   silent fallback to an unrelated binary;
 * - packaged Bun hosts resolve the package beside the executable; callers can
 *   still pass an explicit `packageRoot` or addon path when composing another
 *   package layout;
 * - every operation validates the C ABI `{ok,result}|{ok,error}` envelope in
 *   TypeScript and surfaces typed errors (`IrohNativeOperationError` with the
 *   native code preserved); raw unknown JSON is never returned to callers.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

import { classifyIrohNativeErrorCode, IrohError } from './errors.js';
export { MACHINE_ALPN, MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from './descriptor.js';
export { classifyIrohHomeCarrierFailure, IrohError } from './errors.js';
export type { IrohHomeCarrierFailureClassification } from './errors.js';
export {
  IROH_RELAY_POLICY_ENV_KEY,
  IROH_RELAY_URLS_ENV_KEY,
  readIrohRelayConfigFromEnv,
} from './relayConfig.js';
export type { IrohRelayEnvConfig } from './relayConfig.js';
export type { IrohRelayPolicy } from './types.js';
export type { NativeIrohModule } from './HappierIrohNative.types.js';
export { createNodeIrohHomeTunnelSession } from './nodeHomeTunnelSession.js';
export type { NodeIrohHomeTunnelLease, NodeIrohHomeTunnelSession } from './nodeHomeTunnelSession.js';
import {
  IROH_NODE_NATIVE_EXPORTS,
  type IrohNodeAcceptorStarted,
  type IrohNodeAcceptorStatus,
  type IrohNodeCreateEndpointRequest,
  type IrohNodeEndpointCreated,
  type IrohNodeEndpointHandleRequest,
  type IrohNodeEndpointStatus,
  type IrohNodeEnsureHomeTunnelRequest,
  type IrohNodeMachineTunnelStarted,
  type IrohNodeMachineHttpTunnelStarted,
  type IrohNodeMachineTunnelStatus,
  type IrohNodeNativeAddon,
  type IrohNodeStartHomeAcceptorRequest,
  type IrohNodeStartMachineAcceptorRequest,
  type IrohNodeStartMachineHttpTunnelRequest,
  type IrohNodeStartMachineTunnelRequest,
  type IrohNodeTunnelStarted,
  type IrohNodeTunnelStatus,
  type LoadIrohNodeNativeResult,
  type NodeIrohNativeModule,
} from './nodeNative.types.js';
import type { IrohObservedPath } from './types.js';

export {
  IROH_MACHINE_ADMISSION_PATH,
  IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
  IROH_MACHINE_APPLICATION_PORT_HEADER,
  IROH_MACHINE_REMOTE_ENDPOINT_HEADER,
  IROH_MACHINE_STREAM_ACCEPT_BYTE,
  IROH_MACHINE_STREAM_REJECT_BYTE,
} from './nodeNative.types.js';

export const IROH_NODE_NATIVE_ADDON_PREFIX = 'happier-iroh-native-lifecycle';

export const SUPPORTED_IROH_NODE_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
] as const;

export type IrohNodeTarget = (typeof SUPPORTED_IROH_NODE_TARGETS)[number];

/**
 * Deterministic artifact name per platform/arch pair. Linux libc variants are
 * chosen at build time by the host (one host has exactly one libc); see
 * `scripts/build-node-addon.mjs --musl`.
 */
export function resolveIrohNodeAddonArtifactName(platform: string, arch: string): string {
  const target = `${platform}-${arch}`;
  if (!(SUPPORTED_IROH_NODE_TARGETS as readonly string[]).includes(target)) {
    throw new Error(
      `@happier-dev/iroh-native has no Node/Bun lifecycle addon for ${target}; supported: ${SUPPORTED_IROH_NODE_TARGETS.join(', ')}`,
    );
  }
  return `${IROH_NODE_NATIVE_ADDON_PREFIX}.${target}.node`;
}

export function resolveDefaultIrohNodePackageRoot({
  moduleUrl = import.meta.url,
  executablePath = process.execPath,
  pathExists = existsSync,
}: Readonly<{
  moduleUrl?: string;
  executablePath?: string;
  pathExists?: (path: string) => boolean;
}> = {}): string {
  const modulePackageRoot = dirname(dirname(fileURLToPath(moduleUrl)));
  if (pathExists(join(modulePackageRoot, 'package.json'))) return modulePackageRoot;

  // Bun-compiled modules have a virtual module URL. Their native sidecar is
  // deliberately staged beside the executable under the ordinary package root.
  return join(dirname(executablePath), 'node_modules', '@happier-dev', 'iroh-native');
}

export function resolveIrohNodeAddonPath(
  packageRoot: string = resolveDefaultIrohNodePackageRoot(),
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return join(packageRoot, 'native', resolveIrohNodeAddonArtifactName(platform, arch));
}

function requireNodeAddon(addonPath: string): unknown {
  const requireFromAddon = createRequire(pathToFileURL(addonPath));
  return requireFromAddon(addonPath);
}

function readAddonExports(candidate: unknown): IrohNodeNativeAddon | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  for (const name of IROH_NODE_NATIVE_EXPORTS) {
    if (typeof record[name] !== 'function') return null;
  }
  return candidate as IrohNodeNativeAddon;
}

/**
 * Loads and surface-validates the raw addon at `addonPath`. Throws when the
 * file cannot be loaded or does not expose the full lifecycle surface.
 */
export function loadIrohNodeNativeAddon(addonPath: string): IrohNodeNativeAddon {
  const candidate = requireNodeAddon(addonPath);
  const addon = readAddonExports(candidate);
  if (!addon) {
    throw new Error(
      `${addonPath} does not expose the Iroh Node/Bun lifecycle surface (${IROH_NODE_NATIVE_EXPORTS.join(', ')})`,
    );
  }
  return addon;
}

/**
 * Resolves and loads the lifecycle addon for the current (or explicit)
 * platform/arch, returning the typed module or a `native_unavailable` result.
 */
export function loadIrohNodeNative(
  packageRoot: string = resolveDefaultIrohNodePackageRoot(),
  platform: string = process.platform,
  arch: string = process.arch,
): LoadIrohNodeNativeResult {
  let addonPath: string;
  try {
    addonPath = resolveIrohNodeAddonPath(packageRoot, platform, arch);
  } catch (error) {
    return {
      available: false,
      reason: 'native_unavailable',
      message: error instanceof Error ? error.message : String(error),
      addonPath: null,
    };
  }
  let addon: IrohNodeNativeAddon;
  try {
    addon = loadIrohNodeNativeAddon(addonPath);
  } catch (error) {
    return {
      available: false,
      reason: 'native_unavailable',
      message: `Iroh Node/Bun lifecycle addon unavailable at ${addonPath}: ${error instanceof Error ? error.message : String(error)}`,
      addonPath,
    };
  }
  return { available: true, native: createIrohNodeNativeModule(addon), addonPath };
}

/** Typed failure of one C ABI lifecycle operation. */
export class IrohNativeOperationError extends IrohError {
  /** Exact C ABI error code, preserved for diagnostics. */
  readonly nativeCode: string;

  constructor(nativeCode: string, message: string, options?: { cause?: unknown }) {
    super(classifyIrohNativeErrorCode(nativeCode), message, options);
    this.name = 'IrohNativeOperationError';
    this.nativeCode = nativeCode;
  }
}

type IrohNodeEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; nativeCode: string; message: string };

function parseEnvelope(raw: string): IrohNodeEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IrohError('unknown', 'Iroh native addon returned a non-JSON response');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new IrohError('unknown', 'Iroh native addon returned a malformed response envelope');
  }
  const envelope = parsed as { ok?: unknown; result?: unknown; error?: unknown };
  if (typeof envelope.ok !== 'boolean') {
    throw new IrohError('unknown', 'Iroh native addon returned a response without an ok flag');
  }
  if (envelope.ok) {
    return { ok: true, result: 'result' in envelope ? envelope.result : null };
  }
  const error =
    typeof envelope.error === 'object' && envelope.error !== null
      ? (envelope.error as { code?: unknown; message?: unknown })
      : null;
  if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw new IrohError('unknown', 'Iroh native addon returned a malformed error envelope');
  }
  return { ok: false, nativeCode: error.code, message: error.message };
}

async function callOperation(response: Promise<string>): Promise<unknown> {
  const envelope = parseEnvelope(await response);
  if (!envelope.ok) throw new IrohNativeOperationError(envelope.nativeCode, envelope.message);
  return envelope.result;
}

async function requireNullResult(result: Promise<unknown>, operation: string): Promise<void> {
  const value = await result;
  if (value !== null) {
    throw new IrohError('unknown', `Iroh native ${operation} returned an unexpected result payload`);
  }
}

// --- response field validators (fail closed on contract drift) ------------

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IrohError('unknown', `Iroh native ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IrohError('unknown', `Iroh native response field ${field} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new IrohError('unknown', `Iroh native response field ${field} must be a boolean`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IrohError('unknown', `Iroh native response field ${field} must be a finite number`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new IrohError('unknown', `Iroh native response field ${field} must be a string array`);
  }
  return value;
}

function requireObservedPath(value: unknown): IrohObservedPath {
  if (value === 'direct' || value === 'relay' || value === 'unknown') return value;
  throw new IrohError(
    'unknown',
    'Iroh native response field observedPath must be direct, relay, or unknown',
  );
}

function requireIrohCarrier(value: unknown): 'iroh' {
  if (value === 'iroh') return value;
  throw new IrohError('unknown', 'Iroh native response field carrier must be "iroh"');
}

function requireLoopbackHttpOrigin(value: unknown): string {
  const origin = requireString(value, 'runtimeOrigin');
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol === 'http:'
      && isLoopbackHostname(parsed.hostname)
      && parsed.pathname === '/'
      && parsed.search === ''
    ) {
      return origin;
    }
  } catch {
    // Fall through to the typed error below.
  }
  throw new IrohError(
    'unknown',
    `Iroh native response runtimeOrigin must be a loopback http origin, got ${origin}`,
  );
}

function validateTunnelIdentityFields(record: Record<string, unknown>) {
  return {
    homeServerIdentityId: requireString(record.homeServerIdentityId, 'homeServerIdentityId'),
    runtimeOrigin: requireLoopbackHttpOrigin(record.runtimeOrigin),
    carrier: requireIrohCarrier(record.carrier),
    observedPath: requireObservedPath(record.observedPath),
    startedAtMs: requireNumber(record.startedAtMs, 'startedAtMs'),
  };
}

function validateTunnelStarted(result: unknown): IrohNodeTunnelStarted {
  const record = requireRecord(result, 'ensureHomeTunnel result');
  return {
    tunnelId: requireString(record.tunnelId, 'tunnelId'),
    homeEndpointId: requireString(record.homeEndpointId, 'homeEndpointId'),
    ...validateTunnelIdentityFields(record),
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
  };
}

function validateAcceptorStatus(result: unknown): IrohNodeAcceptorStatus {
  const record = requireRecord(result, 'acceptor status');
  let lastPath: IrohNodeAcceptorStatus['lastPath'] = null;
  if (record.lastPath !== null && record.lastPath !== undefined) {
    const path = requireRecord(record.lastPath, 'acceptor lastPath');
    lastPath = {
      observedPath: requireObservedPath(path.observedPath),
      isRelay: requireBoolean(path.isRelay, 'isRelay'),
      remoteEndpointId: requireString(path.remoteEndpointId, 'remoteEndpointId'),
      atMs: requireNumber(path.atMs, 'atMs'),
    };
  }
  return {
    running: requireBoolean(record.running, 'running'),
    connectionsAccepted: requireNumber(record.connectionsAccepted, 'connectionsAccepted'),
    connectionsActive: requireNumber(record.connectionsActive, 'connectionsActive'),
    streamsAccepted: requireNumber(record.streamsAccepted, 'streamsAccepted'),
    ...(record.streamsActive === undefined
      ? {}
      : { streamsActive: requireNumber(record.streamsActive, 'streamsActive') }),
    streamsRejected: requireNumber(record.streamsRejected, 'streamsRejected'),
    ...(record.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: record.lastErrorCode === null ? null : requireString(record.lastErrorCode, 'lastErrorCode') as IrohNodeAcceptorStatus['lastErrorCode'] }),
    lastPath,
  };
}

function validateAcceptorStarted(result: unknown): IrohNodeAcceptorStarted {
  const record = requireRecord(result, 'startHomeAcceptor result');
  return {
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
    reused: requireBoolean(record.reused, 'reused'),
    status: validateAcceptorStatus(record.status),
  };
}

function validateMachineTunnelStarted(result: unknown): IrohNodeMachineTunnelStarted {
  const record = requireRecord(result, 'startMachineTunnel result');
  const localCapability = record.localCapability === null || record.localCapability === undefined
    ? undefined
    : requireString(record.localCapability, 'localCapability');
  if (localCapability !== undefined && !/^[0-9a-f]{64}$/.test(localCapability)) {
    throw new IrohError('unknown', 'Iroh native response field localCapability must be 64 lowercase hexadecimal characters');
  }
  return {
    machineTunnelId: requireString(record.machineTunnelId, 'machineTunnelId'),
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
    localPort: requireNumber(record.localPort, 'localPort'),
    ...(localCapability === undefined ? {} : { localCapability }),
    connectionActive: requireBoolean(record.connectionActive, 'connectionActive'),
    remoteEndpointId: requireString(record.remoteEndpointId, 'remoteEndpointId'),
    observedPath: requireObservedPath(record.observedPath),
    startedAtMs: requireNumber(record.startedAtMs, 'startedAtMs'),
    lastErrorCode: record.lastErrorCode === null ? null : requireString(record.lastErrorCode, 'lastErrorCode') as IrohNodeMachineTunnelStarted['lastErrorCode'],
  };
}

function validateMachineHttpTunnelStarted(result: unknown): IrohNodeMachineHttpTunnelStarted {
  const record = requireRecord(result, 'startMachineHttpTunnel result');
  const localCapability = requireString(record.localCapability, 'localCapability');
  if (!/^[0-9a-f]{64}$/.test(localCapability)) {
    throw new IrohError('unknown', 'Iroh native response field localCapability must be 64 lowercase hexadecimal characters');
  }
  return {
    machineTunnelId: requireString(record.machineTunnelId, 'machineTunnelId'),
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
    localPort: requireNumber(record.localPort, 'localPort'),
    localCapability,
    connectionActive: requireBoolean(record.connectionActive, 'connectionActive'),
    remoteEndpointId: requireString(record.remoteEndpointId, 'remoteEndpointId'),
    observedPath: requireObservedPath(record.observedPath),
    startedAtMs: requireNumber(record.startedAtMs, 'startedAtMs'),
    lastErrorCode: record.lastErrorCode === null ? null : requireString(record.lastErrorCode, 'lastErrorCode') as IrohNodeMachineHttpTunnelStarted['lastErrorCode'],
  };
}

function validateMachineTunnelStatus(result: unknown): IrohNodeMachineTunnelStatus | null {
  if (result === null) return null;
  const record = requireRecord(result, 'getMachineTunnelStatus result');
  return {
    machineTunnelId: requireString(record.machineTunnelId, 'machineTunnelId'),
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
    localPort: requireNumber(record.localPort, 'localPort'),
    connectionActive: requireBoolean(record.connectionActive, 'connectionActive'),
    remoteEndpointId: requireString(record.remoteEndpointId, 'remoteEndpointId'),
    observedPath: requireObservedPath(record.observedPath),
    startedAtMs: requireNumber(record.startedAtMs, 'startedAtMs'),
    lastErrorCode: record.lastErrorCode === null ? null : requireString(record.lastErrorCode, 'lastErrorCode') as IrohNodeMachineTunnelStatus['lastErrorCode'],
    streamsOpened: requireNumber(record.streamsOpened, 'streamsOpened'),
  };
}

function validateEndpointCreated(result: unknown): IrohNodeEndpointCreated {
  const record = requireRecord(result, 'createEndpoint result');
  const relayMode = record.relayMode;
  if (relayMode !== 'disabled' && relayMode !== 'custom') {
    throw new IrohError('unknown', 'Iroh native response field relayMode must be disabled or custom');
  }
  const relayPolicy = requireRelayPolicy(record.relayPolicy);
  return {
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
    endpointId: requireString(record.endpointId, 'endpointId'),
    relayPolicy,
    relayMode,
    capProfile: requireString(record.capProfile, 'capProfile'),
    relayUrls: requireStringArray(record.relayUrls, 'relayUrls'),
  };
}

function requireRelayPolicy(value: unknown): 'automatic' | 'disabled' {
  if (value !== 'automatic' && value !== 'disabled') {
    throw new IrohError('unknown', 'Iroh native response field relayPolicy must be automatic or disabled');
  }
  return value;
}

function validateEndpointStatus(result: unknown): IrohNodeEndpointStatus | null {
  if (result === null) return null;
  const record = requireRecord(result, 'getEndpointStatus result');
  return {
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
    endpointId: requireString(record.endpointId, 'endpointId'),
    relayPolicy: requireRelayPolicy(record.relayPolicy),
    relayMode: requireString(record.relayMode, 'relayMode'),
    relayUrls: requireStringArray(record.relayUrls, 'relayUrls'),
    capProfile: requireString(record.capProfile, 'capProfile'),
    directAddresses: requireStringArray(record.directAddresses, 'directAddresses'),
    active: requireBoolean(record.active, 'active'),
  };
}

function validateTunnelStatus(result: unknown): IrohNodeTunnelStatus | null {
  if (result === null) return null;
  const record = requireRecord(result, 'getTunnelStatus result');
  return {
    tunnelId: requireString(record.tunnelId, 'tunnelId'),
    ...validateTunnelIdentityFields(record),
    connectionActive: requireBoolean(record.connectionActive, 'connectionActive'),
    streamsOpened: requireNumber(record.streamsOpened, 'streamsOpened'),
    endpointHandle: requireString(record.endpointHandle, 'endpointHandle'),
  };
}

// --- request serialization ------------------------------------------------

function serializeRequest(request: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)),
  );
}

/**
 * Wraps a surface-validated raw addon into the typed lifecycle module. The
 * addon remains the only runtime owner; this factory adds typing, envelope
 * validation, and typed errors exclusively.
 */
export function createIrohNodeNativeModule(addon: IrohNodeNativeAddon): NodeIrohNativeModule {
  return {
    getAvailability: () => addon.getAvailability(),
    createEndpoint: async (request: IrohNodeCreateEndpointRequest) =>
      validateEndpointCreated(await callOperation(addon.createEndpoint(serializeRequest({ ...request })))),
    startHomeAcceptor: async (request: IrohNodeStartHomeAcceptorRequest) =>
      validateAcceptorStarted(await callOperation(addon.startHomeAcceptor(serializeRequest({ ...request })))),
    stopHomeAcceptor: async (request: IrohNodeEndpointHandleRequest) => {
      await requireNullResult(
        callOperation(addon.stopHomeAcceptor(serializeRequest({ endpointHandle: request.endpointHandle }))),
        'stopHomeAcceptor',
      );
    },
    ensureHomeTunnel: async (request: IrohNodeEnsureHomeTunnelRequest) =>
      validateTunnelStarted(await callOperation(addon.ensureHomeTunnel(serializeRequest({ ...request })))),
    releaseHomeTunnel: async (tunnelId: string) => {
      await requireNullResult(
        callOperation(addon.releaseHomeTunnel(serializeRequest({ tunnelId }))),
        'releaseHomeTunnel',
      );
    },
    shutdownEndpoint: async (request: IrohNodeEndpointHandleRequest) => {
      const result = await callOperation(
        addon.shutdownEndpoint(serializeRequest({ endpointHandle: request.endpointHandle })),
      );
      if (result !== null) {
        requireBoolean(requireRecord(result, 'shutdownEndpoint result').stopped, 'stopped');
      }
    },
    getEndpointStatus: async (endpointHandle: string) =>
      validateEndpointStatus(await callOperation(addon.getEndpointStatus(serializeRequest({ endpointHandle })))),
    getTunnelStatus: async (tunnelId: string) =>
      validateTunnelStatus(await callOperation(addon.getTunnelStatus(serializeRequest({ tunnelId })))),
    startMachineAcceptor: async (request: IrohNodeStartMachineAcceptorRequest) =>
      validateAcceptorStarted(await callOperation(addon.startMachineAcceptor(serializeRequest({ ...request })))),
    stopMachineAcceptor: async (request: IrohNodeEndpointHandleRequest) => {
      await requireNullResult(callOperation(addon.stopMachineAcceptor(serializeRequest({ ...request }))), 'stopMachineAcceptor');
    },
    getMachineAcceptorStatus: async (endpointHandle: string) => {
      const result = await callOperation(addon.getMachineAcceptorStatus(serializeRequest({ endpointHandle })));
      return result === null ? null : validateAcceptorStatus(result);
    },
    startMachineTunnel: async (request: IrohNodeStartMachineTunnelRequest) => {
      const result = validateMachineTunnelStarted(await callOperation(addon.startMachineTunnel(serializeRequest({ ...request }))));
      if (request.nativeHttpLease && result.localCapability !== undefined) {
        await requireNullResult(callOperation(addon.stopMachineTunnel(serializeRequest({ machineTunnelId: result.machineTunnelId }))), 'stopMachineTunnel');
        throw new IrohError('unknown', 'Guest HTTP lease must not disclose a native capability');
      }
      return result;
    },
    startMachineHttpTunnel: async (request: IrohNodeStartMachineHttpTunnelRequest) => {
      const { handshakeProvider, ...serialized } = request;
      if (!handshakeProvider) {
        return validateMachineHttpTunnelStarted(
          await callOperation(addon.startMachineHttpTunnel(serializeRequest(serialized))),
        );
      }
      return validateMachineHttpTunnelStarted(
        await callOperation(addon.startMachineHttpTunnel(
          serializeRequest(serialized),
          async () => {
            const handshakeJson = await handshakeProvider();
            if (typeof handshakeJson !== 'string') {
              throw new TypeError('Iroh machine handshake provider must resolve to a string');
            }
            return handshakeJson;
          },
        )),
      );
    },
    stopMachineTunnel: async (machineTunnelId: string) => {
      await requireNullResult(callOperation(addon.stopMachineTunnel(serializeRequest({ machineTunnelId }))), 'stopMachineTunnel');
    },
    getMachineTunnelStatus: async (machineTunnelId: string) =>
      validateMachineTunnelStatus(await callOperation(addon.getMachineTunnelStatus(serializeRequest({ machineTunnelId })))),
  };
}
