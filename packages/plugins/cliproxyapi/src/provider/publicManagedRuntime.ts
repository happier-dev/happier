import type {
  ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

import { PLUGIN_MANIFEST } from '../manifest.js';
import {
  CLIPROXYAPI_MANAGED_ENV,
  CLIPROXYAPI_MANAGED_HEALTH_IDENTITY,
  CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED,
  CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES,
  CLIPROXYAPI_MANAGED_SERVICE,
} from './managedContract.js';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from './contribution.js';

const MANAGED_HEALTH_IDENTITY_KEYS = Object.freeze([
  'v',
  'contractVersion',
  'sdkVersion',
  'wrapperBuildVersion',
  'protocols',
  'purposes',
  'modelListEnabled',
]);
const MANAGED_HEALTH_PURPOSE_KEYS = Object.freeze(['consumer', 'purpose']);
const MANAGED_HEALTH_CONSUMER_KEYS = Object.freeze(['pluginId', 'localId']);

type ManagedPurposeFamily = typeof CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES[number];

type ManagedPurposeSnapshot = Readonly<{
  protocols: readonly string[];
  endpointTemplateIds: readonly string[];
  healthPurposes: readonly Readonly<{
    consumer: Readonly<{ pluginId: string; localId: string }>;
    purpose: string;
  }>[];
  serializedPurposeConfiguration: string;
}>;

function identityMismatch(): Error {
  return new Error('CLIProxyAPI managed wrapper identity mismatch');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('CLIProxyAPI managed wrapper identity request was aborted');
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))
  ) return null;
  return value as Readonly<Record<string, unknown>>;
}

function matchesProtocols(
  value: unknown,
  expectedProtocols: readonly string[],
): boolean {
  return Array.isArray(value)
    && value.length === expectedProtocols.length
    && expectedProtocols.every((protocol, index) => (
      value[index] === protocol
    ));
}

function matchesPurposes(
  value: unknown,
  expectedPurposes: ManagedPurposeSnapshot['healthPurposes'],
): boolean {
  return Array.isArray(value)
    && value.length === expectedPurposes.length
    && expectedPurposes.every((expected, index) => {
      const purpose = exactRecord(value[index], MANAGED_HEALTH_PURPOSE_KEYS);
      const consumer = purpose
        ? exactRecord(purpose.consumer, MANAGED_HEALTH_CONSUMER_KEYS)
        : null;
      return purpose?.purpose === expected.purpose
        && consumer?.pluginId === expected.consumer.pluginId
        && consumer.localId === expected.consumer.localId;
    });
}

function matchesManagedHealthIdentity(
  value: unknown,
  purposeSnapshot: ManagedPurposeSnapshot,
): boolean {
  const identity = exactRecord(value, MANAGED_HEALTH_IDENTITY_KEYS);
  if (!identity) return false;
  const wrapperBuildVersion = identity.wrapperBuildVersion;
  return identity.v === CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.v
    && identity.contractVersion
      === CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.contractVersion
    && identity.sdkVersion === CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.sdkVersion
    && typeof wrapperBuildVersion === 'string'
    && wrapperBuildVersion.length > 0
    && wrapperBuildVersion === wrapperBuildVersion.trim()
    && new TextEncoder().encode(wrapperBuildVersion).byteLength
      <= CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.wrapperBuildVersionMaxBytes
    && matchesProtocols(identity.protocols, purposeSnapshot.protocols)
    && matchesPurposes(identity.purposes, purposeSnapshot.healthPurposes)
    && identity.modelListEnabled
      === CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.modelListEnabled;
}

function readContentType(
  headers: Readonly<Record<string, string>>,
): string | null {
  let contentType: string | null = null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-type') continue;
    if (contentType !== null) return null;
    contentType = value;
  }
  return contentType;
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The readiness error remains authoritative.
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelForAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelForAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw identityMismatch();
      totalBytes += chunk.value.byteLength;
      if (
        totalBytes
        > CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.responseMaxBytes
      ) {
        try {
          await reader.cancel();
        } catch {
          // The bounded-body failure remains authoritative.
        }
        throw identityMismatch();
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener('abort', cancelForAbort);
    reader.releaseLock();
  }
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bodyBytes;
}

async function assertManagedHealthIdentity(
  service: ManagedServiceHandle,
  signal: AbortSignal,
  purposeSnapshot: ManagedPurposeSnapshot,
): Promise<void> {
  throwIfAborted(signal);
  const response = await service.request({
    pathAndQuery: CLIPROXYAPI_MANAGED_SERVICE.healthPath,
    method: 'GET',
    signal,
  });
  throwIfAborted(signal);
  const contentType = readContentType(response.headers);
  if (
    response.ok !== true
    || !Number.isSafeInteger(response.status)
    || response.status < 200
    || response.status > 299
    || contentType === null
    || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    || response.body === null
  ) {
    await cancelBody(response.body);
    throw identityMismatch();
  }
  const bytes = await readBoundedBody(response.body, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw identityMismatch();
  }
  if (!matchesManagedHealthIdentity(parsed, purposeSnapshot)) throw identityMismatch();
  throwIfAborted(signal);
}

async function resolveManagedPurposeSnapshot(
  context: Parameters<ManagedProviderRuntime['start']>[1],
): Promise<ManagedPurposeSnapshot> {
  throwIfAborted(context.signal);
  const families: ManagedPurposeFamily[] = [];
  for (const family of CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES) {
    const binding = await context.connectedAccounts.getBinding(
      family.purpose,
      { signal: context.signal },
    );
    throwIfAborted(context.signal);
    if (binding !== null) families.push(family);
  }
  if (families.length === 0) {
    throw new Error(
      'CLIProxyAPI managed runtime requires at least one bound Connected Account purpose',
    );
  }
  const boundFamilies = Object.freeze([...families]);
  const protocols = Object.freeze(boundFamilies.flatMap((family) => [
    ...family.protocols,
  ]));
  const endpointTemplateIds = Object.freeze(boundFamilies.flatMap((family) => [
    ...family.endpointTemplateIds,
  ]));
  const healthPurposes = Object.freeze(boundFamilies.map((family) => Object.freeze({
    consumer: Object.freeze({
      pluginId: PLUGIN_MANIFEST.id,
      localId: CLIPROXYAPI_PROVIDER_CONTRIBUTION.id,
    }),
    purpose: family.purpose,
  })));
  return Object.freeze({
    protocols,
    endpointTemplateIds,
    healthPurposes,
    serializedPurposeConfiguration: JSON.stringify({
      v: 2,
      modelListEnabled: CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED,
      purposes: boundFamilies.map((family) => ({
        id: family.authEntry.id,
        provider: family.authEntry.provider,
        consumer: {
          pluginId: PLUGIN_MANIFEST.id,
          localId: CLIPROXYAPI_PROVIDER_CONTRIBUTION.id,
        },
        purpose: family.purpose,
        allowedHttpsOrigin: family.requestAuth.materialization.origin,
        protocols: family.protocols,
      })),
    }),
  });
}

function publicManagedServiceSpec(
  purposeSnapshot: ManagedPurposeSnapshot,
): ManagedServiceSpec {
  return Object.freeze({
    id: CLIPROXYAPI_MANAGED_SERVICE.id,
    requestAuth: Object.freeze({
      kind: 'connectedAccountCapabilityPath' as const,
      injectEnvironmentKey: CLIPROXYAPI_MANAGED_ENV.requestAuthCapabilityPath,
    }),
    clientAccess: Object.freeze({
      kind: 'hostBearer' as const,
      injectEnvironmentKey: CLIPROXYAPI_MANAGED_ENV.downstreamBearer,
      headerName: 'authorization',
      scheme: 'Bearer' as const,
    }),
    mode: Object.freeze({
      kind: 'spawn' as const,
      launch: Object.freeze({
        executable: Object.freeze({
          kind: CLIPROXYAPI_MANAGED_SERVICE.executable.kind,
          directorySegments:
            CLIPROXYAPI_MANAGED_SERVICE.executable.directorySegments,
          executableBaseName:
            CLIPROXYAPI_MANAGED_SERVICE.executable.executableBaseName,
        }),
        env: Object.freeze({
          HOST: CLIPROXYAPI_MANAGED_SERVICE.host,
          [CLIPROXYAPI_MANAGED_ENV.purposeConfiguration]:
            purposeSnapshot.serializedPurposeConfiguration,
        }),
      }),
      endpoint: Object.freeze({
        kind: 'assignAndInject' as const,
        host: CLIPROXYAPI_MANAGED_SERVICE.host,
        port: Object.freeze({ kind: 'allocated' as const }),
        inject: Object.freeze({
          portEnvironmentKey:
            CLIPROXYAPI_MANAGED_SERVICE.portEnvironmentKey,
        }),
      }),
    }),
    healthCheck: Object.freeze({
      kind: 'http' as const,
      target: Object.freeze({
        kind: 'servicePath' as const,
        path: CLIPROXYAPI_MANAGED_SERVICE.healthPath,
      }),
    }),
  });
}

// A catalog probe reads the managed wrapper's own model list, which the service
// serves regardless of which upstream purposes are bound. Every declared probe
// endpoint therefore stays reachable for a catalog probe start, so declaring a
// second probe never silently costs the provider its catalog.
const CATALOG_PROBE_ENDPOINT_TEMPLATE_IDS: ReadonlySet<string> = new Set(
  CLIPROXYAPI_PROVIDER_CONTRIBUTION.catalog.probes.map(
    (probe) => probe.endpointTemplateId,
  ),
);

const start: ManagedProviderRuntime['start'] = async (request, context) => {
  const purposeSnapshot = await resolveManagedPurposeSnapshot(context);
  const admitsCatalogProbeEndpoints = request.reason === 'catalogProbe';
  const endpointTemplateIds = Object.freeze(request.endpointTemplateIds.filter(
    (endpointTemplateId) => purposeSnapshot.endpointTemplateIds.includes(
      endpointTemplateId,
    ) || (admitsCatalogProbeEndpoints
      && CATALOG_PROBE_ENDPOINT_TEMPLATE_IDS.has(endpointTemplateId)),
  ));
  if (endpointTemplateIds.length === 0) {
    throw new Error(
      'CLIProxyAPI managed runtime has no requested endpoint backed by a bound purpose',
    );
  }
  const service = await context.managedServices.supervise(
    publicManagedServiceSpec(purposeSnapshot),
    { signal: context.signal },
  );
  try {
    const snapshot = await service.waitUntilHealthy({ signal: context.signal });
    if (snapshot.state !== 'healthy') {
      throw new Error('CLIProxyAPI managed service did not become healthy');
    }
    await assertManagedHealthIdentity(service, context.signal, purposeSnapshot);
    if (service.snapshot().state !== 'healthy') {
      throw new Error('CLIProxyAPI managed service became unhealthy during identity validation');
    }
  } catch (error) {
    try {
      await service.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'CLIProxyAPI managed service readiness and cleanup failed',
      );
    }
    throw error;
  }

  return Object.freeze({
    service,
    endpoints: Object.freeze(endpointTemplateIds.map((endpointTemplateId) => (
      Object.freeze({
        endpointTemplateId,
        endpoint: Object.freeze({
          kind: 'servicePath' as const,
          path: endpointTemplateId === 'cliproxyapi-anthropic' ? '/' : '/v1',
        }),
      })
    ))),
  });
};

export const CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME: ManagedProviderRuntime =
  Object.freeze({ start });
