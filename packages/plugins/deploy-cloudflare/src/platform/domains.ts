import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetDomainResultV1ProtocolSchema as output,
  PluginError, isPluginError, type DeploymentTargetDomainInputV1, type DeploymentTargetDomainResultV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { request } from './deploymentHttp.js';
import { pagesCommon, pagesIo } from './pagesPrepare.js';

type Operation = 'read' | 'add' | 'verify' | 'remove';
function refuse(code: string): never {
  const error = new PluginError({ code, ...(code === 'deployment_unavailable'
    ? { failureCause: projectActionFailureCauseV1({ code }, 'deployment.cloudflare.domain') } : {}) });
  throw code === 'deployment_unavailable' ? withActionFailureDiagnostic(error, { phase: 'deployment.cloudflare.domain', causeKind: 'not_found' }) : error;
}
async function native(context: PluginAccountActionContext, input: DeploymentTargetDomainInputV1,
  path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown) {
  const reply = await request(pagesIo(context), input.providerIdentity.providerAccountId, path,
    method === 'GET' ? 'observe' : 'send', method, body);
  if ('code' in reply) throw withActionFailureDiagnostic(new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase },
    failureCause: projectActionFailureCauseV1(reply, `deployment.cloudflare.${reply.phase}`) }),
    { phase: `deployment.cloudflare.${reply.phase}`, causeKind: 'native_failure', error: reply });
  return reply.value;
}
function removed(input: DeploymentTargetDomainInputV1): DeploymentTargetDomainResultV1 {
  return { v: 1, hostname: input.domain.hostname, state: 'removed', dns: [] };
}
function isAbsent(error: unknown): boolean { return isPluginError(error) && error.code === 'deployment_unavailable'; }

/** Project-wide Pages domains are production only. Verification reads provider DNS/certificate status.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/
 * https://developers.cloudflare.com/api/resources/workers/subresources/domains/ (checked 2026-11-10).
 */
async function pages(input: DeploymentTargetDomainInputV1, context: PluginAccountActionContext, operation: Operation): Promise<DeploymentTargetDomainResultV1> {
  if (input.providerEnvironment.kind !== 'production') refuse('unsupported_action');
  const projectName = input.preparedNative?.projectName;
  if (!projectName) refuse('deployment_content_unavailable');
  const root = `/pages/projects/${encodeURIComponent(projectName)}`;
  const project = await native(context, input, root);
  if (!isObject(project) || project.id !== input.providerIdentity.providerResourceId || project.name !== projectName
    || typeof project.subdomain !== 'string' || !project.subdomain) refuse('provider_response_invalid');
  const path = `${root}/domains/${encodeURIComponent(input.domain.hostname)}`;
  if (operation === 'remove') {
    try { await native(context, input, path, 'DELETE'); }
    catch (error) { if (!isAbsent(error)) throw error; }
    return removed(input);
  }
  const value = operation === 'add'
    ? await native(context, input, `${root}/domains`, 'POST', { name: input.domain.hostname })
    : await native(context, input, path);
  if (!isObject(value) || value.name !== input.domain.hostname || typeof value.status !== 'string') refuse('provider_response_invalid');
  const dns: DeploymentTargetDomainResultV1['dns'] = [{ type: 'CNAME', name: input.domain.hostname, value: project.subdomain }];
  if (isObject(value.validation_data) && value.validation_data.method === 'txt'
    && typeof value.validation_data.txt_name === 'string' && typeof value.validation_data.txt_value === 'string') {
    dns.push({ type: 'TXT', name: value.validation_data.txt_name, value: value.validation_data.txt_value });
  }
  let state: DeploymentTargetDomainResultV1['state'];
  switch (value.status) {
    case 'active': state = 'active'; break;
    case 'initializing': case 'pending': state = 'pending'; break;
    case 'deactivated': case 'blocked': case 'error': state = 'failed'; break;
    default: return refuse('provider_response_invalid');
  }
  return { v: 1, hostname: input.domain.hostname, state, dns };
}

async function workers(input: DeploymentTargetDomainInputV1, context: PluginAccountActionContext, operation: Operation): Promise<DeploymentTargetDomainResultV1> {
  const environment = input.providerEnvironment;
  if (environment.kind !== 'script') refuse('unsupported_action');
  const zone = input.domain.zone;
  if (!zone) refuse('deployment_invalid');
  const root = '/workers/domains';
  const parseRow = (row: unknown): { id: string; enabled: boolean } => {
    if (!isObject(row) || row.hostname !== input.domain.hostname || typeof row.id !== 'string' || !row.id
      || row.service !== environment.scriptName || row.zone_id !== zone.zoneId || row.zone_name !== zone.name
      || typeof row.enabled !== 'boolean') refuse('deployment_conflict');
    return { id: row.id, enabled: row.enabled };
  };
  const read = async () => {
    const rows = await native(context, input, `${root}?${new URLSearchParams({ hostname: input.domain.hostname })}`);
    if (!Array.isArray(rows) || rows.some(row => !isObject(row) || row.hostname !== input.domain.hostname)) refuse('provider_response_invalid');
    if (rows.length > 1) refuse('provider_response_invalid');
    const row: unknown = rows[0];
    if (row === undefined) return null;
    return parseRow(row);
  };
  let row = await read();
  if (operation === 'add' && row === null) {
    row = parseRow(await native(context, input, root, 'PUT', { hostname: input.domain.hostname, service: environment.scriptName,
      enabled: true, zone_id: zone.zoneId, zone_name: zone.name }));
  }
  if (operation === 'remove') {
    if (row === null) return removed(input);
    await native(context, input, `${root}/${encodeURIComponent(row.id)}`, 'DELETE');
    return removed(input);
  }
  if (row === null) refuse('deployment_unavailable');
  return { v: 1, hostname: input.domain.hostname, state: row.enabled ? 'active' : 'pending', dns: [] };
}

function action(product: 'pages' | 'workers', operation: Operation): PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>> {
  const write = operation === 'add' || operation === 'remove';
  return { ...pagesCommon, hostAccess: [`cloudflare-${product}`, 'deploy.manage'],
    title: `${operation} Cloudflare ${product} Domain`, dangerLevel: write ? 'writesRemote' as const : 'safe' as const,
    readOnly: !write, ...(write ? { confirmation: { title: `${operation} this Cloudflare Domain?` } } : {}),
    inputSchema: inputs[`domains.${operation}`].jsonSchema, resultSchema: output.jsonSchema,
    async run(raw: JsonValue, context: PluginAccountActionContext): Promise<JsonValue> {
      const input = raw as unknown as DeploymentTargetDomainInputV1;
      return product === 'pages' ? pages(input, context, operation) : workers(input, context, operation);
    } };
}
export const domainActions = {
  'pages-domains-read': action('pages', 'read'), 'pages-domains-add': action('pages', 'add'),
  'pages-domains-verify': action('pages', 'verify'), 'pages-domains-remove': action('pages', 'remove'),
  'workers-domains-read': action('workers', 'read'), 'workers-domains-add': action('workers', 'add'),
  'workers-domains-verify': action('workers', 'verify'), 'workers-domains-remove': action('workers', 'remove'),
} as const;
