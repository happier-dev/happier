import type {
  ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServiceResponse,
  ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

import {
  CLIPROXYAPI_MANAGED_ENV,
  CLIPROXYAPI_MANAGED_CLIENT_ACCESS,
  CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES,
  CLIPROXYAPI_MANAGED_SERVICE,
} from './managedContract.js';
import { CLIPROXYAPI_MANAGED_HEALTH_IDENTITY, CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED } from './managedProjection.js';
import {
  CLIPROXYAPI_PLUGIN_ID,
  CLIPROXYAPI_PROVIDER_CONTRIBUTION,
  CLIPROXYAPI_PROVIDER_LOCAL_ID,
} from './contribution.js';

type ManagedPurposeSnapshot = Readonly<{
  protocols: readonly string[];
  endpointTemplateIds: readonly string[];
  healthPurposes: readonly Readonly<{
    consumer: Readonly<{ pluginId: string; localId: string }>;
    purpose: string;
  }>[];
  serializedPurposeConfiguration: string;
  modelListEnabled: boolean;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesProtocols(
  value: unknown,
  expectedProtocols: readonly string[],
): boolean {
  return Array.isArray(value)
    && expectedProtocols.every(protocol => value.includes(protocol));
}

function matchesPurposes(
  value: unknown,
  expectedPurposes: ManagedPurposeSnapshot['healthPurposes'],
): boolean {
  return Array.isArray(value)
    && expectedPurposes.every(expected => value.some(purpose => isRecord(purpose)
      && purpose.purpose === expected.purpose
      && isRecord(purpose.consumer)
      && purpose.consumer.pluginId === expected.consumer.pluginId
      && purpose.consumer.localId === expected.consumer.localId));
}

function matchesManagedHealthIdentity(
  value: unknown,
  purposeSnapshot: ManagedPurposeSnapshot,
): boolean {
  if (!isRecord(value)) return false;
  const identity = value;
  return identity.v === CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.v
    && identity.contractVersion
      === CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.contractVersion
    && identity.sdkVersion === CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.sdkVersion
    && matchesProtocols(identity.protocols, purposeSnapshot.protocols)
    && matchesPurposes(identity.purposes, purposeSnapshot.healthPurposes)
    && identity.modelListEnabled === purposeSnapshot.modelListEnabled
    && identity.sourceClass === 'connected_account';
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
  body: ManagedServiceResponse['body'],
): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The readiness error remains authoritative.
  }
}

async function readHealthBody(
  body: NonNullable<ManagedServiceResponse['body']>,
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
  const bytes = await readHealthBody(response.body, signal);
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
  const families = CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES;
  let hasBoundPurpose = false;
  for (const family of families) {
    const binding = await context.connectedAccounts.getBinding(
      family.purpose,
      { signal: context.signal },
    );
    throwIfAborted(context.signal);
    hasBoundPurpose ||= binding !== null;
  }
  if (!hasBoundPurpose) {
    throw new Error('CLIProxyAPI managed runtime requires an exact upstream source');
  }
  // Physical configuration declares supported translation families. The host's
  // per-consumer capability registry, rather than this union, grants access.
  const protocols = Object.freeze([...new Set(families.flatMap((family) => [
    ...family.protocols,
  ]))]);
  const endpointTemplateIds = Object.freeze(
    CLIPROXYAPI_PROVIDER_CONTRIBUTION.endpointTemplates
      .filter((endpoint) => protocols.includes(endpoint.protocol))
      .map((endpoint) => endpoint.id),
  );
  const healthPurposes = Object.freeze(families.map((family) => Object.freeze({
    consumer: Object.freeze({
      pluginId: CLIPROXYAPI_PLUGIN_ID,
      localId: CLIPROXYAPI_PROVIDER_LOCAL_ID,
    }),
    purpose: family.purpose,
  })));
  return Object.freeze({
    protocols,
    endpointTemplateIds,
    healthPurposes,
    modelListEnabled: CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED,
    serializedPurposeConfiguration: JSON.stringify({
      v: 3,
      modelListEnabled: CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED,
      purposes: families.map((family) => ({
        id: family.authEntry.id,
        provider: family.authEntry.provider,
        consumer: {
          pluginId: CLIPROXYAPI_PLUGIN_ID,
          localId: CLIPROXYAPI_PROVIDER_LOCAL_ID,
        },
        purpose: family.purpose,
        allowedHttpsOrigins: family.origins,
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
      kind: 'connectedAccountConsumerAccessPath' as const,
      injectEnvironmentKey: CLIPROXYAPI_MANAGED_ENV.consumerAccessPath,
    }),
    clientAccess: CLIPROXYAPI_MANAGED_CLIENT_ACCESS,
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
