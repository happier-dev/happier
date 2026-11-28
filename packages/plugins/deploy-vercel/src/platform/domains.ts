import { vercelRoleSchema, type VercelRoleInput } from './selection.js';
import { withActionFailureDiagnostic, isPluginError, projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetDomainResultV1ProtocolSchema as output,
  PluginError, settleDeploymentTargetDomainRemovalV1,
  type DeploymentTargetDomainInputV1, type DeploymentTargetDomainResultV1 as Result,
  type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { vercelEndpoint, vercelRequest } from './operations.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code: string): never => {
  const error = new PluginError({ code });
  throw code === 'deployment_unavailable' ? withActionFailureDiagnostic(error, { phase: 'deployment.vercel.domain', causeKind: 'not_found' }) : error;
};
/** Project Domains v10 add/v9 get+remove and domain config v6, official API inspected 2026-11-10.
 * Verify asks Vercel to re-check DNS; its POST changes no user configuration (owner ruling 2026-11-14).
 * A lost configuration write remains unknown and the next explicit Action can recover it.
 */
async function run(input: Input, ctx: PluginAccountActionContext, operation: 'add' | 'read' | 'verify' | 'remove'): Promise<Result> {
  if (!ctx.services.http) return fail('client_required');
  const environment = input.providerEnvironment.selection;
  const gitBranch = environment.kind === 'preview' ? environment.gitBranch : undefined;
  const hostname = input.domain.hostname;
  const project = input.providerIdentity.providerResourceId;
  const account = input.providerIdentity.providerAccountId;
  const io = { http: ctx.services.http, signal: ctx.signal, now: () => Date.now() };
  const endpoint = vercelEndpoint(`/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(hostname)}`, account);
  async function request(url: string, requestOperation: readonly ['read', 'GET' | 'POST'] | readonly ['write', 'POST' | 'DELETE'], body?: unknown) {
    try { return await vercelRequest(io, url, requestOperation, body === undefined ? undefined
      : { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) }); }
    catch (error) {
      ctx.signal.throwIfAborted();
      if (isPluginError(error)) throw error;
      return fail(requestOperation[0] === 'read' ? 'provider_request_failed' : 'outcome_unknown');
    }
  }
  function check(response: Awaited<ReturnType<typeof request>>) {
    if (response.status < 200 || response.status >= 300) return fail(response.status === 401 || response.status === 403
      ? 'deployment_access_denied' : response.status === 404 ? 'deployment_unavailable' : response.status === 409
        ? 'deployment_conflict' : 'provider_request_failed');
    try { return JSON.parse(new TextDecoder().decode(response.body)) as unknown; } catch { return fail('provider_response_invalid'); }
  }
  function selected(domain: unknown): asserts domain is Record<string, unknown> {
    if (!record(domain) || domain.name !== hostname || domain.projectId !== project
      || (domain.gitBranch ?? undefined) !== gitBranch
      || (domain.customEnvironmentId ?? undefined) !== (environment.kind === 'custom' ? environment.id : undefined)
      || typeof domain.verified !== 'boolean') return fail('target_mismatch');
  }
  let response;
  let verificationFailure: PluginError | undefined;
  if (operation === 'add') {
    response = await request(vercelEndpoint(`/v10/projects/${encodeURIComponent(project)}/domains`, account), ['write', 'POST'], {
      name: hostname, ...(environment.kind === 'preview' && environment.gitBranch ? { gitBranch: environment.gitBranch } : {}),
      ...(environment.kind === 'custom' ? { customEnvironmentId: environment.id } : {}) });
    // Repeating the person's Add can recover a prior acknowledged/ambiguous creation without moving the Domain.
    if (response.status === 400) response = await request(endpoint, ['read', 'GET']);
  } else if (operation === 'verify') {
    async function verifyDomain() {
      const verifyUrl = new URL(endpoint);
      verifyUrl.pathname += '/verify';
      try {
        const verified = await request(verifyUrl.href, ['read', 'POST']);
        if (verified.status !== 400 && verified.status !== 403) return verified;
        verificationFailure = new PluginError({ code: verified.status === 403 ? 'deployment_access_denied' : 'provider_request_failed',
          failureCause: { phase: 'deployment.vercel.domain.verify', errorClass: 'Error', errorCode: null, httpStatus: verified.status } });
      } catch (error) {
        const cause = projectActionFailureCauseV1(error, 'deployment.vercel.domain.verify');
        if (!isPluginError(error) || cause.httpStatus !== 400 && cause.httpStatus !== 403) throw error;
        verificationFailure = error;
      }
      // Missing ownership TXT is an ordinary pending Domain. Read its existing challenge without adding it again.
      return request(endpoint, ['read', 'GET']);
    }
    response = await verifyDomain();
  } else if (operation === 'remove') {
    const readCurrent = async () => {
      try {
        const current = await request(endpoint, ['read', 'GET']);
        if (current.status === 404) return null;
        const domain = check(current);
        selected(domain);
        return domain;
      } catch (error) {
        if (isPluginError(error) && error.code === 'deployment_unavailable') return null;
        throw error;
      }
    };
    if (await readCurrent() === null) return { v: 1, hostname, state: 'removed', dns: [] };
    await settleDeploymentTargetDomainRemovalV1({
      remove: async () => {
        const removed = await request(endpoint, ['write', 'DELETE']);
        if (removed.status !== 404 && (removed.status < 200 || removed.status >= 300)) check(removed);
      },
      observeAbsent: async () => await readCurrent() === null,
    });
    return { v: 1, hostname, state: 'removed', dns: [] };
  } else response = await request(endpoint, ['read', 'GET']);
  const domain = check(response);
  selected(domain);
  if (verificationFailure && domain.verified) throw verificationFailure;
  const dns: Result['dns'] = [];
  for (const value of Array.isArray(domain.verification) ? domain.verification : []) {
    if (record(value) && typeof value.type === 'string' && typeof value.domain === 'string' && typeof value.value === 'string')
      dns.push({ type: value.type, name: value.domain, value: value.value });
  }
  const configUrl = new URL(vercelEndpoint(`/v6/domains/${encodeURIComponent(hostname)}/config`, account));
  configUrl.searchParams.set('projectIdOrName', project);
  const config = check(await request(configUrl.href, ['read', 'GET']));
  if (!record(config) || typeof config.misconfigured !== 'boolean') return fail('provider_response_invalid');
  if (config.misconfigured) {
    // Vercel ranks alternatives; A and CNAME cannot coexist on the same name.
    // Follow its apex A / subdomain CNAME guidance using the preferred rank.
    const cname = (Array.isArray(config.recommendedCNAME) ? config.recommendedCNAME : [])
      .find(row => record(row) && row.rank === 1);
    const ipv4 = (Array.isArray(config.recommendedIPv4) ? config.recommendedIPv4 : [])
      .find(row => record(row) && row.rank === 1);
    const cnames: Result['dns'] = record(cname) && typeof cname.value === 'string'
      ? [{ type: 'CNAME', name: hostname, value: cname.value }] : [];
    const addresses: Result['dns'] = record(ipv4) && Array.isArray(ipv4.value)
      ? ipv4.value.filter((value): value is string => typeof value === 'string')
        .map(value => ({ type: 'A', name: hostname, value })) : [];
    const isApex = domain.apexName === hostname;
    const preferred = isApex ? addresses : cnames;
    dns.push(...(preferred.length ? preferred : isApex ? cnames : addresses));
  }
  return { v: 1, hostname, state: !domain.verified || config.misconfigured ? 'pending' : 'active', dns,
    ...(verificationFailure ? { failureCause: projectActionFailureCauseV1(verificationFailure, 'deployment.vercel.domain.verify') } : {}) };
}
const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [], hostAccess: ['vercel-api', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }], resultSchema: output.jsonSchema } as const;
type Input = VercelRoleInput<DeploymentTargetDomainInputV1>;
type DomainAction = PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>;
export const domainActions: Readonly<Record<`domains-${'add' | 'read' | 'verify' | 'remove'}`, DomainAction>> = {
  'domains-add': { ...common, title: 'Add the reviewed Vercel Domain', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Add this Domain to Vercel?' }, inputSchema: vercelRoleSchema(inputs['domains.add'].jsonSchema),
    run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'add') },
  'domains-read': { ...common, title: 'Read the selected Vercel Domain', dangerLevel: 'safe', readOnly: true,
    inputSchema: vercelRoleSchema(inputs['domains.read'].jsonSchema), run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'read') },
  'domains-verify': { ...common, title: 'Verify the selected Vercel Domain', dangerLevel: 'safe', readOnly: true,
    inputSchema: vercelRoleSchema(inputs['domains.verify'].jsonSchema), run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'verify') },
  'domains-remove': { ...common, title: 'Remove the selected Vercel Domain', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Remove this Domain from Vercel?' }, inputSchema: vercelRoleSchema(inputs['domains.remove'].jsonSchema),
    run: (input: JsonValue, ctx: PluginAccountActionContext) => run(input as unknown as Input, ctx, 'remove') },
} as const;
