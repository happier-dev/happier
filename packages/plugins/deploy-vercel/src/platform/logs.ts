import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetLogsResultV1ProtocolSchema as output,
  PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { vercelEndpoint, vercelRequest } from './operations.js';

/** Finite JSON snapshot of the exact retained deployment; no provider polling.
 * https://vercel.com/docs/rest-api/deployments/get-deployment-events (v3, 2026-11-07).
 */
export const buildLogsAction = {
  title: 'Read the selected Vercel build logs',
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['vercel-api', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  dangerLevel: 'safe', readOnly: true, inputSchema: inputs['logs.build'].jsonSchema, resultSchema: output.jsonSchema,
  async run(raw: JsonValue, context: PluginAccountActionContext) {
    // The Action owner has admitted this exact schema, including receipt custody.
    const input = raw as unknown as ReturnType<typeof inputs['logs.build']['parse']>;
    const fail = (code: string): never => { throw new PluginError({ code, retryable: false, details: { phase: 'build' } }); };
    if (!context.services.http) return fail('client_required');
    if (!input.providerDeploymentId) return fail('deployment_content_unavailable');
    const sourceRevision = input.providerDeploymentId;
    if (input.cursor && input.cursor.sourceRevision !== sourceRevision) return { kind: 'source-changed', sourceRevision };
    const url = new URL(vercelEndpoint(`/v3/deployments/${encodeURIComponent(sourceRevision)}/events`, input.providerIdentity.providerAccountId));
    url.searchParams.set('direction', 'forward');
    url.searchParams.set('follow', '0');
    // Vercel documents -1 as all available logs; do not silently accept its default limit.
    url.searchParams.set('limit', '-1');
    if (input.ref) url.searchParams.set('name', input.ref);
    const response = await vercelRequest({ http: context.services.http, signal: context.signal, now: Date.now }, url.href, 'GET');
    if (response.status < 200 || response.status >= 300) return fail(response.status === 401 || response.status === 403
      ? 'deployment_access_denied' : response.status === 404 ? 'deployment_unavailable' : 'provider_request_failed');
    let events: unknown;
    try { events = JSON.parse(new TextDecoder().decode(response.body)); } catch { return fail('provider_response_invalid'); }
    if (!Array.isArray(events)) return fail('provider_response_invalid');
    const lines: string[] = [];
    const entries: unknown[] = events;
    for (const event of entries) {
      if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') return fail('provider_response_invalid');
      // Vercel documents both wrapped payloads and flat events in this response union.
      const payload: unknown = 'payload' in event ? event.payload : event;
      if (!payload || typeof payload !== 'object') return fail('provider_response_invalid');
      if ('text' in payload && payload.text !== undefined) {
        if (typeof payload.text !== 'string') return fail('provider_response_invalid');
        lines.push(payload.text.endsWith('\n') ? payload.text : `${payload.text}\n`);
      }
    }
    return { kind: 'page', page: { sourceRevision, text: lines.join(''), nextCursor: null, truncated: false } };
  },
} as const;
