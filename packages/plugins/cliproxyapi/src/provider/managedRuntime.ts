import { Buffer } from 'node:buffer';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  ProviderWireProtocol,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';
import {
  isConnectedAccountRequestAuthMaterializationId,
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
type CliProxyApiOutputTee = Readonly<{
  onChunk(stream: 'stdout' | 'stderr', chunk: Uint8Array): void;
}>;

export const CLIPROXYAPI_MANAGED_CONTRACT_VERSION =
  'happier.cliproxyapi-managed/v1';
export const CLIPROXYAPI_MANAGED_SDK_VERSION = 'v7.2.95';

const READINESS_OUTPUT_LIMIT_BYTES = 512 * 1024;
const MANAGED_PROTOCOLS = new Set<ProviderWireProtocol>([
  'anthropic',
  'openai-chat',
  'openai-responses',
]);
const AUTH_ENTRY_ID_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u;
const CONTRIBUTION_LOCAL_ID_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u;
const PLUGIN_ID_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const RESERVED_PLUGIN_ID_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export type CliProxyApiManagedAuthEntry = Readonly<{
  id: string;
  provider: 'codex' | 'claude';
  purpose: QualifiedConnectedAccountPurposeV1;
}>;

export type CliProxyApiManagedReadiness = Readonly<{
  contractVersion: string;
  sdkVersion: string;
  protocols: readonly ProviderWireProtocol[];
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
}>;

export type CliProxyApiManagedRecoveryHealth = Readonly<{
  v: 1;
  contractVersion: string;
  sdkVersion: string;
  wrapperBuildVersion: string;
  protocols: readonly ProviderWireProtocol[];
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  modelListEnabled: boolean;
  materializationId: string;
}>;

type CliProxyApiReadinessObserver = Readonly<{
  outputTee: CliProxyApiOutputTee;
  wait: (signal?: AbortSignal) => Promise<CliProxyApiManagedReadiness>;
}>;

export type CliProxyApiManagedRuntimePreparation = Readonly<{
  materializedRootDir: string;
  materializationId: string;
  privateConfigPath: string;
  expectedReadiness: Readonly<{
    contractVersion: string;
    sdkVersion: string;
  }>;
  prepared: Readonly<{
    downstreamBearer: string;
    protocols: readonly ProviderWireProtocol[];
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    readiness: CliProxyApiReadinessObserver;
  }>;
  cleanup: () => Promise<void>;
}>;

export type CliProxyApiManagedRuntimeInput = Readonly<{
  materializedRootDir: string;
  materializationId: string;
  wrapperBuildVersion: string;
  downstreamBearer: string;
  authEntries: readonly CliProxyApiManagedAuthEntry[];
  protocols: readonly ProviderWireProtocol[];
  modelListEnabled: boolean;
  requestAuth: Readonly<{
    capabilityPath: string;
  }>;
}>;

export type CliProxyApiManagedRuntimeAdapterInput = Readonly<
  Omit<CliProxyApiManagedRuntimeInput, 'authEntries'> & {
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
  }
>;

export type CliProxyApiManagedAgentEndpointInput = Readonly<{
  host: string;
  port: number;
  protocol: ProviderWireProtocol;
  endpointTemplateId: string;
}>;

export type CliProxyApiPrivateFileOperations = Readonly<{
  writeExclusive: (input: Readonly<{
    path: string;
    contents: string;
  }>) => Promise<void>;
  remove: (path: string) => Promise<void>;
}>;

export type CliProxyApiManagedRuntimeRecoveryInput = Readonly<{
  materializedRootDir: string;
  materializationId: string;
  capabilityPath: string;
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  protocols: readonly ProviderWireProtocol[];
  modelListEnabled: boolean;
}>;

type ReadinessLineResult =
  | Readonly<{ kind: 'unrelated' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{
      kind: 'ready';
      readiness: CliProxyApiManagedReadiness;
    }>;

function hasExactKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => (
      typeof key === 'string'
      && expected.includes(key)
    ));
}

function isValidPluginId(value: string): boolean {
  if (
    value === ''
    || value === '.'
    || value === '..'
    || value.startsWith('.')
    || value.endsWith('.')
    || value.includes('/')
    || value.includes('\\')
  ) {
    return false;
  }
  const segments = value.split('.');
  return segments.length >= 2
    && segments.every((segment) => (
      !RESERVED_PLUGIN_ID_SEGMENTS.has(segment)
      && PLUGIN_ID_SEGMENT_PATTERN.test(segment)
    ));
}

function normalizePurpose(value: unknown): QualifiedConnectedAccountPurposeV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!hasExactKeys(value, ['consumer', 'purpose'])) return null;
  const record = value as Record<string, unknown>;
  if (
    !record.consumer
    || typeof record.consumer !== 'object'
    || Array.isArray(record.consumer)
    || !hasExactKeys(record.consumer, ['pluginId', 'localId'])
  ) {
    return null;
  }
  const consumer = record.consumer as Record<string, unknown>;
  if (
    typeof consumer.pluginId !== 'string'
    || !isValidPluginId(consumer.pluginId)
    || typeof consumer.localId !== 'string'
    || consumer.localId !== consumer.localId.trim()
    || !CONTRIBUTION_LOCAL_ID_PATTERN.test(consumer.localId)
    || typeof record.purpose !== 'string'
    || record.purpose !== record.purpose.trim()
    || record.purpose.length === 0
    || record.purpose.length > 128
  ) {
    return null;
  }
  return Object.freeze({
    consumer: Object.freeze({
      pluginId: consumer.pluginId,
      localId: consumer.localId,
    }),
    purpose: record.purpose,
  });
}

function purposeKey(purpose: QualifiedConnectedAccountPurposeV1): string {
  return JSON.stringify([
    purpose.consumer.pluginId,
    purpose.consumer.localId,
    purpose.purpose,
  ]);
}

function sameUniqueStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && [...leftSet].every((value) => rightSet.has(value));
}

export function parseCliProxyApiManagedRecoveryHealth(
  contents: string,
  expected: CliProxyApiManagedRecoveryHealth,
): CliProxyApiManagedRecoveryHealth | null {
  try {
    if (
      typeof contents !== 'string'
      || Buffer.byteLength(contents, 'utf8') > 64 * 1024
    ) {
      return null;
    }
    const value: unknown = JSON.parse(contents);
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || !hasExactKeys(value, [
        'v',
        'contractVersion',
        'sdkVersion',
        'wrapperBuildVersion',
        'protocols',
        'purposes',
        'modelListEnabled',
        'materializationId',
      ])
    ) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      record.v !== 1
      || typeof record.contractVersion !== 'string'
      || typeof record.sdkVersion !== 'string'
      || typeof record.wrapperBuildVersion !== 'string'
      || !Array.isArray(record.protocols)
      || !record.protocols.every((protocol) => (
        typeof protocol === 'string'
        && MANAGED_PROTOCOLS.has(protocol as ProviderWireProtocol)
      ))
      || !Array.isArray(record.purposes)
      || typeof record.modelListEnabled !== 'boolean'
      || typeof record.materializationId !== 'string'
    ) {
      return null;
    }
    const purposes = record.purposes.map(normalizePurpose);
    if (purposes.some((purpose) => purpose === null)) return null;
    const protocols = record.protocols as ProviderWireProtocol[];
    const normalizedPurposes =
      purposes as QualifiedConnectedAccountPurposeV1[];
    if (
      record.contractVersion !== expected.contractVersion
      || record.sdkVersion !== expected.sdkVersion
      || record.wrapperBuildVersion !== expected.wrapperBuildVersion
      || record.modelListEnabled !== expected.modelListEnabled
      || record.materializationId !== expected.materializationId
      || !sameUniqueStringSet(protocols, expected.protocols)
      || !sameUniqueStringSet(
        normalizedPurposes.map(purposeKey),
        expected.purposes.map(purposeKey),
      )
    ) {
      return null;
    }
    return Object.freeze({
      v: 1,
      contractVersion: record.contractVersion,
      sdkVersion: record.sdkVersion,
      wrapperBuildVersion: record.wrapperBuildVersion,
      protocols: Object.freeze([...protocols]),
      purposes: Object.freeze([...normalizedPurposes]),
      modelListEnabled: record.modelListEnabled,
      materializationId: record.materializationId,
    });
  } catch {
    return null;
  }
}

function parseReadinessLine(
  line: string,
  expected: CliProxyApiManagedReadiness,
): ReadinessLineResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return { kind: 'unrelated' };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return trimmed.includes('"contractVersion"')
      ? { kind: 'invalid' }
      : { kind: 'unrelated' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unrelated' };
  }
  const record = value as Record<string, unknown>;
  const readinessLike = [
    'contractVersion',
    'sdkVersion',
    'protocols',
    'purposes',
  ].some((key) => Object.hasOwn(record, key));
  if (!readinessLike) return { kind: 'unrelated' };
  if (
    !hasExactKeys(record, [
      'contractVersion',
      'sdkVersion',
      'protocols',
      'purposes',
    ])
    || typeof record.contractVersion !== 'string'
    || typeof record.sdkVersion !== 'string'
    || !Array.isArray(record.protocols)
    || !record.protocols.every((protocol) => (
      typeof protocol === 'string'
      && MANAGED_PROTOCOLS.has(protocol as ProviderWireProtocol)
    ))
    || !Array.isArray(record.purposes)
  ) {
    return { kind: 'invalid' };
  }
  const purposes = record.purposes.map(normalizePurpose);
  if (purposes.some((purpose) => purpose === null)) return { kind: 'invalid' };
  const protocols = record.protocols as ProviderWireProtocol[];
  const normalizedPurposes = purposes as QualifiedConnectedAccountPurposeV1[];
  if (
    record.contractVersion !== expected.contractVersion
    || record.sdkVersion !== expected.sdkVersion
    || !sameUniqueStringSet(protocols, expected.protocols)
    || !sameUniqueStringSet(
      normalizedPurposes.map(purposeKey),
      expected.purposes.map(purposeKey),
    )
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'ready',
    readiness: Object.freeze({
      contractVersion: record.contractVersion,
      sdkVersion: record.sdkVersion,
      protocols: Object.freeze([...protocols]),
      purposes: Object.freeze([...normalizedPurposes]),
    }),
  };
}

export function scanCliProxyApiManagedReadiness(
  output: string,
  expected: CliProxyApiManagedReadiness,
): CliProxyApiManagedReadiness | null {
  let matched: CliProxyApiManagedReadiness | null = null;
  for (const line of output.split(/\r?\n/u)) {
    const result = parseReadinessLine(line, expected);
    if (result.kind === 'invalid') return null;
    if (result.kind !== 'ready') continue;
    if (matched) return null;
    matched = result.readiness;
  }
  return matched;
}

function createReadinessObserver(
  expected: CliProxyApiManagedReadiness,
): CliProxyApiReadinessObserver & Readonly<{ dispose: () => void }> {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let observedBytes = 0;
  let settled = false;
  let resolveReadiness!: (value: CliProxyApiManagedReadiness) => void;
  let rejectReadiness!: (error: Error) => void;
  const readiness = new Promise<CliProxyApiManagedReadiness>((resolvePromise, rejectPromise) => {
    resolveReadiness = resolvePromise;
    rejectReadiness = rejectPromise;
  });
  // Output can arrive before the lifecycle owner starts waiting. Retain the rejection for `wait`
  // without allowing that scheduling order to create an unhandled rejection.
  void readiness.catch(() => undefined);

  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectReadiness(error);
  };
  const consumeLine = (line: string): void => {
    const result = parseReadinessLine(line, expected);
    if (result.kind === 'invalid') {
      fail(new Error('CLIProxyAPI managed runtime readiness output is invalid'));
      return;
    }
    if (result.kind === 'ready' && !settled) {
      settled = true;
      resolveReadiness(result.readiness);
    }
  };
  const consumeChunk = (chunk: Uint8Array): void => {
    if (settled) return;
    observedBytes += chunk.byteLength;
    if (observedBytes > READINESS_OUTPUT_LIMIT_BYTES) {
      fail(new Error('CLIProxyAPI managed runtime readiness output exceeded its bounded limit'));
      return;
    }
    buffered += decoder.write(Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    ));
    let newline = buffered.indexOf('\n');
    while (newline >= 0 && !settled) {
      const line = buffered.slice(0, newline).replace(/\r$/u, '');
      buffered = buffered.slice(newline + 1);
      consumeLine(line);
      newline = buffered.indexOf('\n');
    }
  };

  const outputTee: CliProxyApiOutputTee = Object.freeze({
    onChunk: (stream, chunk) => {
      if (stream !== 'stdout') return;
      try {
        consumeChunk(chunk);
      } catch {
        fail(new Error('CLIProxyAPI managed runtime readiness output is invalid'));
      }
    },
  });

  const wait = (signal?: AbortSignal): Promise<CliProxyApiManagedReadiness> => {
    if (!signal) return readiness;
    if (signal.aborted) {
      const error = new Error('CLIProxyAPI managed runtime readiness wait was aborted');
      fail(error);
      return Promise.reject(error);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const abort = () => {
        const error = new Error('CLIProxyAPI managed runtime readiness wait was aborted');
        fail(error);
      };
      signal.addEventListener('abort', abort, { once: true });
      void readiness.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolvePromise(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          rejectPromise(error);
        },
      );
    });
  };

  return Object.freeze({
    outputTee,
    wait,
    dispose: () => {
      fail(new Error('CLIProxyAPI managed runtime readiness observation was disposed'));
    },
  });
}

function normalizeAuthEntries(
  entries: readonly CliProxyApiManagedAuthEntry[],
): readonly CliProxyApiManagedAuthEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('CLIProxyAPI managed runtime requires at least one auth entry');
  }
  const ids = new Set<string>();
  const providers = new Set<string>();
  return Object.freeze(entries.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !hasExactKeys(entry, ['id', 'provider', 'purpose'])
      || typeof entry.id !== 'string'
      || !AUTH_ENTRY_ID_PATTERN.test(entry.id)
      || ids.has(entry.id)
      || (entry.provider !== 'codex' && entry.provider !== 'claude')
      || providers.has(entry.provider)
    ) {
      throw new Error('CLIProxyAPI managed runtime auth entries are invalid or competing');
    }
    const purpose = normalizePurpose(entry.purpose);
    if (!purpose) {
      throw new Error('CLIProxyAPI managed runtime auth entry purpose is invalid');
    }
    ids.add(entry.id);
    providers.add(entry.provider);
    return Object.freeze({
      id: entry.id,
      provider: entry.provider,
      purpose,
    });
  }));
}

function normalizeProtocols(
  protocols: readonly ProviderWireProtocol[],
): readonly ProviderWireProtocol[] {
  if (!Array.isArray(protocols) || protocols.length === 0) {
    throw new Error('CLIProxyAPI managed runtime requires at least one protocol');
  }
  const seen = new Set<ProviderWireProtocol>();
  return Object.freeze(protocols.map((protocol) => {
    if (!MANAGED_PROTOCOLS.has(protocol) || seen.has(protocol)) {
      throw new Error('CLIProxyAPI managed runtime protocols are invalid or duplicated');
    }
    seen.add(protocol);
    return protocol;
  }));
}

export async function inspectCliProxyApiManagedRuntimeRecovery(
  input: CliProxyApiManagedRuntimeRecoveryInput,
  privateFiles: Readonly<{ read: (path: string) => Promise<string> }>,
): Promise<Readonly<{
  privateConfigPath: string;
  capabilityPath: string;
  expectedHealth: CliProxyApiManagedRecoveryHealth;
}> | null> {
  try {
    const materializedRootDir = resolve(input.materializedRootDir);
    const privateConfigPath = resolve(
      materializedRootDir,
      'cliproxyapi-managed.json',
    );
    const capabilityPath = resolve(input.capabilityPath);
    if (
      !isAbsolute(input.materializedRootDir)
      || !isAbsolute(input.capabilityPath)
      || capabilityPath
        !== resolveConnectedAccountRequestAuthCapabilityPath(materializedRootDir)
    ) {
      return null;
    }
    const contents = await privateFiles.read(privateConfigPath);
    if (Buffer.byteLength(contents, 'utf8') > 512 * 1024) return null;
    const value: unknown = JSON.parse(contents);
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || !hasExactKeys(value, [
        'v',
        'materializationId',
        'wrapperBuildVersion',
        'gateway',
        'requestAuth',
      ])
    ) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      record.v !== 1
      || record.materializationId !== input.materializationId
      || typeof record.wrapperBuildVersion !== 'string'
      || record.wrapperBuildVersion.length === 0
      || record.wrapperBuildVersion.trim() !== record.wrapperBuildVersion
      || Buffer.byteLength(record.wrapperBuildVersion, 'utf8') > 256
      || !record.gateway
      || typeof record.gateway !== 'object'
      || Array.isArray(record.gateway)
      || !hasExactKeys(record.gateway, [
        'downstreamBearer',
        'runtimeDir',
        'authEntries',
        'protocols',
        'modelListEnabled',
      ])
      || !record.requestAuth
      || typeof record.requestAuth !== 'object'
      || Array.isArray(record.requestAuth)
      || !hasExactKeys(record.requestAuth, ['capabilityPath'])
    ) {
      return null;
    }
    const gateway = record.gateway as Record<string, unknown>;
    const requestAuth = record.requestAuth as Record<string, unknown>;
    if (
      typeof gateway.downstreamBearer !== 'string'
      || gateway.downstreamBearer.length === 0
      || Buffer.byteLength(gateway.downstreamBearer, 'utf8') > 128 * 1024
      || typeof gateway.runtimeDir !== 'string'
      || resolve(gateway.runtimeDir)
        !== resolve(materializedRootDir, 'cliproxyapi-runtime')
      || !Array.isArray(gateway.authEntries)
      || !Array.isArray(gateway.protocols)
      || gateway.modelListEnabled !== input.modelListEnabled
      || typeof requestAuth.capabilityPath !== 'string'
      || resolve(requestAuth.capabilityPath) !== capabilityPath
    ) {
      return null;
    }
    const actualEntries = normalizeAuthEntries(
      gateway.authEntries as readonly CliProxyApiManagedAuthEntry[],
    );
    const expectedEntries = normalizeAuthEntries(
      input.purposes.map(authEntryForPurpose),
    );
    const actualProtocols = normalizeProtocols(
      gateway.protocols as readonly ProviderWireProtocol[],
    );
    const expectedProtocols = normalizeProtocols(input.protocols);
    if (
      !sameUniqueStringSet(
        actualEntries.map((entry) => JSON.stringify(entry)),
        expectedEntries.map((entry) => JSON.stringify(entry)),
      )
      || !sameUniqueStringSet(actualProtocols, expectedProtocols)
    ) {
      return null;
    }
    return Object.freeze({
      privateConfigPath,
      capabilityPath,
      expectedHealth: Object.freeze({
        v: 1,
        contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
        sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
        wrapperBuildVersion: record.wrapperBuildVersion,
        protocols: expectedProtocols,
        purposes: input.purposes,
        modelListEnabled: input.modelListEnabled,
        materializationId: input.materializationId,
      }),
    });
  } catch {
    return null;
  }
}

export async function prepareCliProxyApiManagedRuntime(
  input: CliProxyApiManagedRuntimeInput,
  privateFiles: CliProxyApiPrivateFileOperations,
): Promise<CliProxyApiManagedRuntimePreparation> {
  if (
    !isAbsolute(input.materializedRootDir)
    || !isAbsolute(input.requestAuth.capabilityPath)
    || resolve(input.requestAuth.capabilityPath)
      !== resolveConnectedAccountRequestAuthCapabilityPath(input.materializedRootDir)
  ) {
    throw new Error('CLIProxyAPI managed runtime private paths are invalid');
  }
  if (
    !isConnectedAccountRequestAuthMaterializationId(input.materializationId)
    || input.downstreamBearer.length === 0
    || Buffer.byteLength(input.downstreamBearer, 'utf8') > 128 * 1024
    || input.wrapperBuildVersion.length === 0
    || input.wrapperBuildVersion.trim() !== input.wrapperBuildVersion
    || Buffer.byteLength(input.wrapperBuildVersion, 'utf8') > 256
  ) {
    throw new Error('CLIProxyAPI managed runtime identity or bearer is invalid');
  }
  const authEntries = normalizeAuthEntries(input.authEntries);
  const protocols = normalizeProtocols(input.protocols);
  const purposes = Object.freeze(authEntries.map((entry) => entry.purpose));
  const expectedReadiness: CliProxyApiManagedReadiness = Object.freeze({
    contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
    sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
    protocols,
    purposes,
  });
  const readiness = createReadinessObserver(expectedReadiness);
  const materializedRootDir = resolve(input.materializedRootDir);
  const privateConfigPath = resolve(materializedRootDir, 'cliproxyapi-managed.json');
  const document = {
    v: 1,
    materializationId: input.materializationId,
    wrapperBuildVersion: input.wrapperBuildVersion,
    gateway: {
      downstreamBearer: input.downstreamBearer,
      runtimeDir: resolve(materializedRootDir, 'cliproxyapi-runtime'),
      authEntries,
      protocols,
      modelListEnabled: input.modelListEnabled,
    },
    requestAuth: {
      capabilityPath: resolve(input.requestAuth.capabilityPath),
    },
  };
  await privateFiles.writeExclusive({
    path: privateConfigPath,
    contents: `${JSON.stringify(document)}\n`,
  });
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    readiness.dispose();
    await privateFiles.remove(privateConfigPath);
  };
  return Object.freeze({
    materializedRootDir,
    materializationId: input.materializationId,
    privateConfigPath,
    expectedReadiness: Object.freeze({
      contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
      sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
    }),
    prepared: Object.freeze({
      downstreamBearer: input.downstreamBearer,
      protocols,
      purposes,
      readiness: Object.freeze({
        outputTee: readiness.outputTee,
        wait: readiness.wait,
      }),
    }),
    cleanup,
  });
}

function authEntryForPurpose(
  purpose: QualifiedConnectedAccountPurposeV1,
): CliProxyApiManagedAuthEntry {
  if (
    purpose.consumer.pluginId !== 'happier.provider.cliproxyapi'
    || purpose.consumer.localId !== 'cliproxyapi'
  ) {
    throw new Error('CLIProxyAPI managed runtime purpose consumer is invalid');
  }
  if (purpose.purpose === 'openai-upstream') {
    return Object.freeze({
      id: 'codex',
      provider: 'codex',
      purpose,
    });
  }
  if (purpose.purpose === 'anthropic-upstream') {
    return Object.freeze({
      id: 'claude',
      provider: 'claude',
      purpose,
    });
  }
  throw new Error('CLIProxyAPI managed runtime purpose is unsupported');
}

export const MANAGED_PROVIDER_RUNTIME_ADAPTER = Object.freeze({
  v: 1 as const,
  catalogSource: Object.freeze({
    kind: 'transientModelEndpoint' as const,
    contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
    sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
  }),
  prepare: async (
    input: CliProxyApiManagedRuntimeAdapterInput,
    privateFiles: CliProxyApiPrivateFileOperations,
  ): Promise<CliProxyApiManagedRuntimePreparation> => (
    prepareCliProxyApiManagedRuntime({
      materializedRootDir: input.materializedRootDir,
      materializationId: input.materializationId,
      wrapperBuildVersion: input.wrapperBuildVersion,
      downstreamBearer: input.downstreamBearer,
      authEntries: input.purposes.map(authEntryForPurpose),
      protocols: input.protocols,
      modelListEnabled: input.modelListEnabled,
      requestAuth: input.requestAuth,
    }, privateFiles)
  ),
  inspectRecovery: inspectCliProxyApiManagedRuntimeRecovery,
  verifyRecoveryHealth: (
    contents: string,
    expected: CliProxyApiManagedRecoveryHealth,
  ): boolean => parseCliProxyApiManagedRecoveryHealth(contents, expected) !== null,
  resolveAgentEndpoint: (
    input: CliProxyApiManagedAgentEndpointInput,
  ): string => {
    const templates = {
      'cliproxyapi-openai-chat': {
        protocol: 'openai-chat',
        suffix: '/v1',
      },
      'cliproxyapi-openai-responses': {
        protocol: 'openai-responses',
        suffix: '/v1',
      },
      'cliproxyapi-anthropic': {
        protocol: 'anthropic',
        suffix: '',
      },
    } as const;
    const template = Object.hasOwn(templates, input.endpointTemplateId)
      ? templates[input.endpointTemplateId as keyof typeof templates]
      : null;
    if (
      input.host !== '127.0.0.1'
      || !Number.isInteger(input.port)
      || input.port < 1
      || input.port > 65_535
      || !template
      || template.protocol !== input.protocol
    ) {
      throw new Error('CLIProxyAPI managed Agent endpoint facts are invalid');
    }
    return `http://127.0.0.1:${input.port}${template.suffix}`;
  },
});
