import { DeploymentDomainDnsRecordInputV1ProtocolSchema as inputSchema,
  DeploymentDomainDnsRecordResultV1ProtocolSchema as resultSchema, PluginError,
  type DeploymentDomainDnsRecordInputV1, type DeploymentDomainDnsRecordResultV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { cloudflareHasNextPage } from './cloudflareRoutes.js';
import { requestZone } from './deploymentHttp.js';
import { pagesCommon, pagesIo } from './pagesPrepare.js';

/** Cloudflare v4 DNS list/create contract, checked 2026-11-14:
 * https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/
 * Reviewed values are semantic content; external-provider routes remain DNS-only.
 * Create adds missing records and preserves every existing record. It never replaces a person's DNS.
 */
async function records(input: DeploymentDomainDnsRecordInputV1, context: PluginAccountActionContext,
  write: boolean): Promise<DeploymentDomainDnsRecordResultV1> {
  const io = pagesIo(context);
  const name = input.name.replace(/\.$/u, '').toLowerCase();
  const configured = new Set<string>();
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ name, type: input.type, page: String(page) });
    const reply = await requestZone(io, input.zoneId, `/dns_records?${query}`);
    if ('code' in reply) throw new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase } });
    if (!Array.isArray(reply.value)) throw new PluginError({ code: 'provider_response_invalid' });
    for (const row of reply.value) {
      if (!isObject(row) || typeof row.name !== 'string' || typeof row.content !== 'string' || typeof row.type !== 'string') {
        throw new PluginError({ code: 'provider_response_invalid' });
      }
      if (row.name.replace(/\.$/u, '').toLowerCase() === name && row.type === input.type
        && row.ttl === input.ttl && row.proxied !== true) configured.add(row.content);
    }
    if (!cloudflareHasNextPage({ result: projectNativeJsonValueForTransport(reply.value),
      ...(reply.resultInfo === undefined ? {} : { result_info: projectNativeJsonValueForTransport(reply.resultInfo) }) },
    page, 'GET /zones/{zone_id}/dns_records')) break;
  }
  const missing = input.values.filter(value => !configured.has(value));
  if (!write) return { kind: missing.length === 0 ? 'configured' : 'pending' };
  for (const content of missing) {
    const reply = await requestZone(io, input.zoneId, '/dns_records', ['write', 'POST'], {
      name, type: input.type, content, ttl: input.ttl, proxied: false,
    });
    if ('code' in reply) {
      if (reply.code === 'outcome_unknown') return { kind: 'unknown', code: reply.code };
      throw new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase } });
    }
    // The acknowledged write is the result; there is no post-write authority/readback loop.
    if (!isObject(reply.value) || typeof reply.value.id !== 'string' || !reply.value.id) {
      return { kind: 'unknown', code: 'provider_response_invalid' };
    }
  }
  return { kind: 'configured' };
}

function action(write: boolean) {
  return { ...pagesCommon, hostAccess: ['cloudflare-dns', 'deploy.manage'], surfaces: ['cli', 'plugin', 'ui', 'agent'] as const,
    title: write ? 'Create reviewed Cloudflare DNS records' : 'Check Cloudflare DNS records',
    dangerLevel: write ? 'writesRemote' as const : 'safe' as const, readOnly: !write,
    ...(write ? { confirmation: { title: 'Create these Cloudflare DNS records?' } } : {}),
    inputSchema: inputSchema.jsonSchema, resultSchema: resultSchema.jsonSchema,
    run(raw: JsonValue, context: PluginAccountActionContext) {
      return records(raw as unknown as DeploymentDomainDnsRecordInputV1, context, write);
    } };
}
export const dnsRecordActions = { 'records-create': action(true), 'records-verify': action(false) } as const;
