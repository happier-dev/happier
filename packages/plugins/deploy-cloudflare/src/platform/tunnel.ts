import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginError, projectActionFailureCauseV1, ActionFailureCauseV1ProtocolSchema, type ActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionContext, PluginAccountActionHandler, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolArray as array, defineProtocolLiteral as literal, defineProtocolObject as object,
  defineProtocolString as string, defineProtocolUnion as union, type ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import { reconcileOwnedCloudflareRoutes, CloudflareProviderRefusal, cloudflareResponseOperation, readCloudflareResponse } from './cloudflareRoutes.js';
import { isObject } from '../connectedAccounts/probe.js';

const closed = { policy: 'closed' } as const;
const text = string({ minLength: 1 });
const dnsOwnership = array(object({ hostname: text, recordId: text }, closed));
const connectorGrants = array(object({ machineId: text, installationId: text, grantRef: text }, closed));
const ownedRoutes = array(object({ hostname: text, path: text.optional(), expectedService: text }, closed));
export const tunnelDisableInput = union([
  object({ credentialRef: QualifiedConnectedAccountRefSchema,
    accountId: text, zoneId: text, tunnelId: text, owned: ownedRoutes, dnsOwnership }, closed),
  object({ credentialRef: QualifiedConnectedAccountRefSchema,
    accountId: text, zoneId: text, tunnelName: text, owned: ownedRoutes,
    dnsOwnership: array(object({ hostname: text, recordId: text }, closed), { maxItems: 0 }) }, closed),
]);
export const tunnelDisableResult = union([
  object({ kind: literal('verified'), tunnelId: text.optional(), dnsOwnership }, closed),
  object({ kind: literal('refused'), code: text, providerOutput: text.optional() }, closed),
  object({ kind: literal('unknown'), code: text, providerOutput: text.optional(), dnsOwnership: dnsOwnership.optional() }, closed),
]);
export const tunnelConfigureInput = object({ credentialRef: QualifiedConnectedAccountRefSchema,
  accountId: text, zoneId: text,
  tunnel: union([
    object({ kind: literal('create'), name: text }, closed),
    object({ kind: literal('adopt'), tunnelId: text, name: text }, closed),
  ]),
  owned: array(object({ hostname: text, path: text.optional(), expectedService: text }, closed)),
  desired: array(object({ hostname: text, path: text.optional(), service: text }, closed)), dnsOwnership }, closed);
type TunnelConfigureResult =
  | Readonly<{ kind: 'prepared'; tunnelId: string; grants: ReturnType<typeof connectorGrants.parse>;
      dnsOwnership: ReturnType<typeof dnsOwnership.parse> }>
  | Readonly<{ kind: 'refused' | 'unknown'; code: string; providerOutput?: string;
      failureCause?: ActionFailureCauseV1; tunnelId?: string;
      grants?: ReturnType<typeof connectorGrants.parse>; dnsOwnership?: ReturnType<typeof dnsOwnership.parse> }>;

export const tunnelConfigureResult: ProtocolComposableSchema<TunnelConfigureResult> = union([
  // Remote configuration and sealed custody are prepared; P20 still owns
  // the token file, actual container reader and connector verification.
  object({ kind: literal('prepared'), tunnelId: text, grants: connectorGrants, dnsOwnership }, closed),
  object({ kind: union([literal('refused'), literal('unknown')]), code: text,
    providerOutput: text.optional(), failureCause: ActionFailureCauseV1ProtocolSchema.optional(),
    tunnelId: text.optional(), grants: connectorGrants.optional(), dnsOwnership: dnsOwnership.optional() }, closed),
]);

/** Cloudflare v4 create/get/token contracts checked 2026-10-31:
 * https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/
 * https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/
 * A lost create is never retried; known coordinates let the parent inspect
 * and deliberately adopt it. No automatic deletion of a shared tunnel.
 */
const configureTunnel: PluginAccountActionHandler<ReturnType<typeof tunnelConfigureInput.parse>,
  ReturnType<typeof tunnelConfigureResult.parse>> = async (input, context) => {
  const { http, machineConnectorSecrets } = context.services;
  if (!http || !machineConnectorSecrets) throw new PluginError({ code: 'controller_services_unavailable' });
  const admittedHttp = http;
  const collection = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`;
  const binding = { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', origin: 'https://api.cloudflare.com', headerNames: ['authorization'] } as const;
  let tunnelId = input.tunnel.kind === 'adopt' ? input.tunnel.tunnelId : undefined;
  // These distinguish an uncertain create or custody write from a read-only
  // refusal; successful custody is carried by the route owner's typed result.
  let createAttempted = false, grantAttempted = false;
  async function request(method: 'GET' | 'POST', url: string, body?: Readonly<Record<string, string>>) {
    context.signal.throwIfAborted();
    if (method === 'POST') createAttempted = true;
    const response = await admittedHttp.request({ method, url, redirect: 'error', credentialBinding: { ...binding, method },
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) }),
    }, { signal: context.signal });
    try {
      if (response.status === 401 || response.status === 403) {
        if (method === 'POST') createAttempted = false;
        throw new PluginError({ code: response.status === 403 ? 'denied' : 'credential_unavailable' });
      }
      if (response.status < 200 || response.status >= 300) throw new PluginError({ code: 'provider_unavailable' });
      return readCloudflareResponse(response.body, cloudflareResponseOperation(method, url)).result;
    } finally { response.body.fill(0); }
  }
  try {
    if (input.tunnel.kind === 'create') {
      const native = await request('POST', collection, { name: input.tunnel.name, config_src: 'cloudflare' });
      if (!isObject(native) || typeof native.id !== 'string' || native.id.length === 0) throw new CloudflareProviderRefusal('invalid_provider_output',
        `${cloudflareResponseOperation('POST', collection)}: result.id expected nonempty string`);
      tunnelId = native.id;
    } else tunnelId = input.tunnel.tunnelId;
    const selectedTunnelId = tunnelId;
    // The existing route owner makes the one native Account/tunnel/name/
    // remote-management decision and performs the owned config/DNS merge.
    const routes = await reconcileOwnedCloudflareRoutes({ ...input, tunnelId, expectedTunnelName: input.tunnel.name,
      http, signal: context.signal,
      async prepareConnector() {
        const token = await request('GET', `${collection}/${encodeURIComponent(selectedTunnelId)}/token`);
        if (typeof token !== 'string' || token.length === 0) throw new CloudflareProviderRefusal('invalid_provider_output',
          `${cloudflareResponseOperation('GET', `${collection}/${encodeURIComponent(selectedTunnelId)}/token`)}: result expected nonempty string`);
        const bytes = new TextEncoder().encode(token);
        try {
          grantAttempted = true;
          return await machineConnectorSecrets.write({ token: bytes,
            subject: { provider: { kind: 'builtin', id: 'cloudflareNamed' }, connectorId: selectedTunnelId } });
        } finally { bytes.fill(0); }
      },
      credentialBindings: { GET: { ...binding, method: 'GET' }, PUT: { ...binding, method: 'PUT' },
        POST: { ...binding, method: 'POST' }, DELETE: { ...binding, method: 'DELETE' } } });
    if (routes.kind !== 'verified') return { kind: createAttempted || grantAttempted || routes.kind === 'unknown' ? 'unknown' : 'refused',
      code: grantAttempted && !routes.connector ? 'connector_grant_unavailable' : routes.code,
      ...(routes.providerOutput ? { providerOutput: routes.providerOutput } : {}),
      ...(routes.failureCause ? { failureCause: routes.failureCause } : {}),
      tunnelId, ...(routes.connector ? { grants: [...routes.connector.grants] } : {}),
      ...(routes.kind === 'unknown' && routes.dnsOwnership ? { dnsOwnership: [...routes.dnsOwnership] } : {}) };
    return { kind: 'prepared', tunnelId, grants: [...routes.connector.grants], dnsOwnership: [...routes.dnsOwnership] };
  } catch (error) {
    const code = createAttempted && !tunnelId ? 'outcome_unknown'
      : context.signal.aborted ? 'cancelled'
        : isPluginError(error) || error instanceof CloudflareProviderRefusal ? error.code : grantAttempted ? 'connector_grant_unavailable' : 'provider_unavailable';
    return { kind: createAttempted || grantAttempted ? 'unknown' : 'refused', code, ...(tunnelId ? { tunnelId } : {}),
      failureCause: projectActionFailureCauseV1(error, 'deployment.cloudflare.tunnel.configure'),
      ...(error instanceof CloudflareProviderRefusal && error.providerOutput ? { providerOutput: error.providerOutput } : {}) };
  }
};

type TunnelAction<TInput extends ProtocolComposableSchema<unknown, JsonValue>,
  TResult extends ProtocolComposableSchema<unknown, JsonValue>> = PluginActionDefinition<
  Omit<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>, 'inputSchema' | 'resultSchema'> & {
    inputSchema: TInput; resultSchema: TResult;
  }>;

export const tunnelActions: Readonly<{
  'cloudflare-named/configure': TunnelAction<typeof tunnelConfigureInput, typeof tunnelConfigureResult>;
  'cloudflare-named/disable': TunnelAction<typeof tunnelDisableInput, typeof tunnelDisableResult>;
}> = {
  'cloudflare-named/configure': {
    title: 'Prepare the reviewed Cloudflare tunnel',
    description: 'Create or adopt the exact remote tunnel, reconcile owned routes and seal its connector token for the admitted Machine.',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
    dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Prepare this Cloudflare tunnel?' },
    inputSchema: tunnelConfigureInput, resultSchema: tunnelConfigureResult,
    hostAccess: ['tunnel.manage', 'cloudflare-tunnel'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'tunnel.manage' }],
    run: configureTunnel,
  },
  'cloudflare-named/disable': {
    title: 'Remove owned Cloudflare tunnel routes',
    description: 'Remove only the reviewed hostname routes and DNS records, preserving the tunnel and other routes.',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
    dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Remove these Cloudflare tunnel routes?' },
    inputSchema: tunnelDisableInput, resultSchema: tunnelDisableResult,
    hostAccess: ['tunnel.manage', 'cloudflare-tunnel'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'tunnel.manage' }],
    run: async (value: JsonValue, context: PluginAccountActionContext) => {
      if (!context.services.http) throw new PluginError({ code: 'client_required' });
      // Action admission already checked this closed schema; the handler uses
      // its admitted shape without re-validating the owner’s decision.
      const input = value as ReturnType<typeof tunnelDisableInput.parse>;
      const binding = { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', origin: 'https://api.cloudflare.com', headerNames: ['authorization'] } as const;
      return await reconcileOwnedCloudflareRoutes({ ...input, http: context.services.http, signal: context.signal, desired: [],
        credentialBindings: { GET: { ...binding, method: 'GET' }, PUT: { ...binding, method: 'PUT' },
          POST: { ...binding, method: 'POST' }, DELETE: { ...binding, method: 'DELETE' } } });
    },
  },
} as const;
