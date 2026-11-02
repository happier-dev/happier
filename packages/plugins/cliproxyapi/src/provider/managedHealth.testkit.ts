import type { ManagedServiceResponse, ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';

import { CLIPROXYAPI_MANAGED_ENV, CLIPROXYAPI_MANAGED_HEALTH_IDENTITY } from './managedContract.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid managed launch fixture');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid managed launch fixture text');
  return value;
}

/** OS/process boundary fixture. Consume the real plugin start's emitted config,
 * rather than maintaining another purpose/protocol/version map in host tests.
 * The actual Go health producer remains covered by the wrapper HTTP suites. */
export function createCLIProxyAPIManagedHealthResponse(spec: ManagedServiceSpec | undefined): ManagedServiceResponse {
  if (spec?.mode.kind !== 'spawn') throw new Error('Missing managed launch fixture');
  const config = record(JSON.parse(text(spec.mode.launch.env?.[CLIPROXYAPI_MANAGED_ENV.purposeConfiguration])));
  if (config.v !== 3 || !Array.isArray(config.purposes) || typeof config.modelListEnabled !== 'boolean') {
    throw new Error('Invalid managed purpose configuration fixture');
  }
  const families = config.purposes.map(value => {
    const family = record(value);
    const consumer = record(family.consumer);
    if (!Array.isArray(family.protocols)) throw new Error('Missing managed protocol fixture');
    return { purpose: text(family.purpose), consumer: { pluginId: text(consumer.pluginId), localId: text(consumer.localId) },
      protocols: family.protocols.map(text) };
  });
  const connection = config.providerConnection === undefined ? null : record(config.providerConnection);
  const identity = {
    v: CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.v,
    contractVersion: CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.contractVersion,
    sdkVersion: CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.sdkVersion,
    wrapperBuildVersion: 'cliproxyapi-test-build',
    protocols: connection ? [text(connection.protocol)] : [...new Set(families.flatMap(family => family.protocols))],
    purposes: families.map(({ consumer, purpose }) => ({ consumer, purpose })),
    modelListEnabled: config.modelListEnabled,
    sourceClass: connection ? 'provider_connection' : 'connected_account',
  };
  return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: Response.json(identity).body };
}
