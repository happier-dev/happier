import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetDomainResultV1ProtocolSchema as output,
  PluginError, type DeploymentTargetDomainInputV1 as Input, type DeploymentTargetDomainResultV1 as Result,
  type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { vercelEndpoint, vercelRequest } from './operations.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code: string): never => { throw new PluginError({ code }); };
/** Project Domains v10 add/v9 get+remove and domain config v6, official API inspected 2026-11-10.
 * Verify reads only. A lost write remains unknown and the next explicit Action can recover it.
 */
async function run(input: Input, ctx: PluginAccountActionContext, operation: 'add' | 'read' | 'remove'): Promise<Result> {
  if (!ctx.services.http) return fail('client_required');
  const environment = input.providerEnvironment;
  if (environment.kind === 'script' || 'scriptName' in environment) return fail('unsupported_action');
  const hostname = input.domain.hostname;
  const project = input.providerIdentity.providerResourceId;
  const account = input.providerIdentity.providerAccountId;
  const io = { http: ctx.services.http, signal: ctx.signal, now: () => Date.now() };
  const endpoint = vercelEndpoint(`/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(hostname)}`, account);
  async function request(url: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) {
    try { return await vercelRequest(io, url, method, body === undefined ? undefined
      : { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) }); }
    catch { ctx.signal.throwIfAborted(); return fail(method === 'GET' ? 'provider_request_failed' : 'outcome_unknown'); }
  }
  function check(response: Awaited<ReturnType<typeof request>>, mutation: boolean) {
    if (response.status < 200 || response.status >= 300) return fail(response.status === 401 || response.status === 403
      ? 'deployment_access_denied' : response.status === 404 ? 'deployment_unavailable' : response.status === 409
        ? 'deployment_conflict' : mutation && response.status >= 500 ? 'outcome_unknown' : 'provider_request_failed');
    try { return JSON.parse(new TextDecoder().decode(response.body)) as unknown; } catch { return fail('provider_response_invalid'); }
  }
  function selected(domain: unknown): asserts domain is Record<string, unknown> {
    if (!record(domain) || domain.name !== hostname || domain.projectId !== project
      || (domain.gitBranch ?? undefined) !== (environment.kind === 'preview' ? environment.gitBranch : undefined)
      || (domain.customEnvironmentId ?? undefined) !== (environment.kind === 'custom' ? environment.id : undefined)
      || typeof domain.verified !== 'boolean') return fail('target_mismatch');
  }
  let response;
  if (operation === 'add') {
    response = await request(vercelEndpoint(`/v10/projects/${encodeURIComponent(project)}/domains`, account), 'POST', {
      name: hostname, ...(environment.kind === 'preview' && environment.gitBranch ? { gitBranch: environment.gitBranch } : {}),
      ...(environment.kind === 'custom' ? { customEnvironmentId: environment.id } : {}) });
    // Repeating the person's Add can recover a prior acknowledged/ambiguous creation without moving the Domain.
    if (response.status === 400) response = await request(endpoint, 'GET');
  } else if (operation === 'remove') {
    const current = await request(endpoint, 'GET');
    if (current.status === 404) return { v: 1, hostname, state: 'removed', dns: [] };
    selected(check(current, false));
    const removed = await request(endpoint, 'DELETE');
    if (removed.status !== 404 && (removed.status < 200 || removed.status >= 300)) check(removed, true);
    // DELETE v9's 200 response acknowledges successful removal.
    return { v: 1, hostname, state: 'removed', dns: [] };
  } else response = await request(endpoint, 'GET');
  const domain = check(response, operation === 'add');
  selected(domain);
  const dns: Result['dns'] = [];
  for (const value of Array.isArray(domain.verification) ? domain.verification : []) {
    if (record(value) && typeof value.type === 'string' && typeof value.domain === 'string' && typeof value.value === 'string')
      dns.push({ type: value.type, name: value.domain, value: value.value });
  }
  if (!domain.verified) return { v: 1, hostname, state: 'pending', dns };
  const configUrl = new URL(vercelEndpoint(`/v6/domains/${encodeURIComponent(hostname)}/config`, account));
  configUrl.searchParams.set('projectIdOrName', project);
  const config = check(await request(configUrl.href, 'GET'), false);
  if (!record(config) || typeof config.misconfigured !== 'boolean') return fail('provider_response_invalid');
  if (config.misconfigured) {
    for (const row of Array.isArray(config.recommendedCNAME) ? config.recommendedCNAME : [])
      if (record(row) && typeof row.value === 'string') dns.push({ type: 'CNAME', name: hostname, value: row.value });
    for (const row of Array.isArray(config.recommendedIPv4) ? config.recommendedIPv4 : [])
      if (record(row) && Array.isArray(row.value)) for (const value of row.value)
        if (typeof value === 'string') dns.push({ type: 'A', name: hostname, value });
  }
  return { v: 1, hostname, state: config.misconfigured ? 'pending' : 'active', dns };
}
const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [], hostAccess: ['vercel-api', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }], resultSchema: output.jsonSchema } as const;
export const domainActions = {
  'domains-add': { ...common, title: 'Add the reviewed Vercel Domain', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Add this Domain to Vercel?' }, inputSchema: inputs['domains.add'].jsonSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'add') },
  'domains-read': { ...common, title: 'Read the selected Vercel Domain', dangerLevel: 'safe', readOnly: true,
    inputSchema: inputs['domains.read'].jsonSchema, run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'read') },
  'domains-verify': { ...common, title: 'Verify the selected Vercel Domain', dangerLevel: 'safe', readOnly: true,
    inputSchema: inputs['domains.verify'].jsonSchema, run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'read') },
  'domains-remove': { ...common, title: 'Remove the selected Vercel Domain', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Remove this Domain from Vercel?' }, inputSchema: inputs['domains.remove'].jsonSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'remove') },
} as const;
