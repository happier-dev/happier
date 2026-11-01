import type { z } from 'zod/mini';
import type { DaemonProviderConnectionEndpointViewV1Schema, DaemonProviderConnectionViewV1 } from '../../rpc/providers.js';
import type { PluginLocalizedStringV2 } from '../../plugins/contributions/publicTypes.js';
import { createProviderErrorV1 } from '../errors.js';
import { providerEndpointPolicySecurityFactsV1 } from '../endpointPolicyV1.js';
import { patchProviderEndpointOverrideV1, resolveEffectiveProviderEndpointV1 } from './effectiveEndpointV1.js';
import type { ProviderEndpointOverrideV1 } from './v1.js';

type EndpointView = z.infer<typeof DaemonProviderConnectionEndpointViewV1Schema>;
type PolicyPatch = Readonly<{ connectionId: string; expectedRevision: number; scope: 'account' | 'machine';
  endpointTemplateId: string; machineId?: string; baseUrl?: string | null; publicHeaders?: Readonly<Record<string, string>> | null }>;

/** Review and admission consume the same current layer facts; caller-authored before values are never accepted. */
export function prepareProviderEndpointPolicyReviewV1(current: Readonly<{
  connectionId: string; revision: number; endpoint: EndpointView; authorityDescription?: PluginLocalizedStringV2 | null;
}>, patch: PolicyPatch) {
  if (current.connectionId !== patch.connectionId || current.revision !== patch.expectedRevision)
    throw createProviderErrorV1('provider_connection_changed', { connectionId: patch.connectionId });
  if (current.endpoint.endpointTemplateId !== patch.endpointTemplateId || patch.scope === 'machine' && !patch.machineId)
    throw createProviderErrorV1('provider_connection_invalid', { connectionId: patch.connectionId });
  const endpoint = current.endpoint;
  const layer = (baseUrl: string | null, publicHeaders: Readonly<Record<string, string>> | null): ProviderEndpointOverrideV1[] =>
    baseUrl !== null || publicHeaders && Object.keys(publicHeaders).length > 0 ? [{ endpointTemplateId: endpoint.endpointTemplateId,
      ...(baseUrl !== null ? { baseUrl } : {}), ...(publicHeaders && Object.keys(publicHeaders).length > 0 ? { publicHeaders } : {}) }] : [];
  const account = layer(endpoint.accountOverrideBaseUrl, endpoint.accountOverridePublicHeaders);
  const machine = layer(endpoint.machineOverrideBaseUrl, endpoint.machineOverridePublicHeaders);
  const template = { id: endpoint.endpointTemplateId, protocol: endpoint.protocol,
    ...(endpoint.defaultBaseUrl ? { baseUrl: endpoint.defaultBaseUrl } : { requiresEndpointOverride: true as const }),
    publicHeaders: endpoint.defaultPublicHeaders,
    ...(endpoint.addressConstraint ? { addressConstraint: endpoint.addressConstraint } : {}),
    ...(endpoint.requiredPublicHeaders ? { requiredPublicHeaders: endpoint.requiredPublicHeaders } : {}) };
  const connection = { endpointOverrides: account,
    ...(patch.scope === 'machine' && patch.machineId ? { endpointOverridesByMachineId: { [patch.machineId]: machine } } : {}) };
  const before = resolveEffectiveProviderEndpointV1({ connection, template, machineId: patch.machineId });
  const updated = patch.scope === 'account' ? { ...connection, endpointOverrides: patchProviderEndpointOverrideV1(account, patch) }
    : { ...connection, endpointOverridesByMachineId: { [patch.machineId!]: patchProviderEndpointOverrideV1(machine, patch) } };
  const after = resolveEffectiveProviderEndpointV1({ connection: updated, template, machineId: patch.machineId });
  const authorityDescription = current.authorityDescription ?? null;
  return { connectionId: current.connectionId, revision: current.revision, endpointTemplateId: endpoint.endpointTemplateId,
    scope: patch.scope, machineId: patch.scope === 'machine' ? patch.machineId! : null,
    before, after, authorityDescription, publicHeaderHints: endpoint.publicHeaderHints ?? {},
    policy: providerEndpointPolicySecurityFactsV1(endpoint) };
}

export type ProviderEndpointPolicyReviewV1 = ReturnType<typeof prepareProviderEndpointPolicyReviewV1>;

/** One text projection for the existing human confirmation and durable approval surfaces. */
export function summarizeProviderEndpointPolicyReviewV1(review: ProviderEndpointPolicyReviewV1): string {
  const text = (value: PluginLocalizedStringV2) => typeof value === 'string' ? value : value.fallback;
  const lines = [review.scope === 'machine' ? 'Machine request policy' : 'Account request policy'];
  const { before, after } = review;
  if (before.baseUrl !== after.baseUrl || before.effectiveSource !== after.effectiveSource) {
    const source = after.effectiveSource === 'template' ? 'Provider default' : after.effectiveSource === 'accountOverride' ? 'Account override' : 'Machine override';
    lines.push(`Address: ${before.baseUrl ?? 'not configured'} → ${after.baseUrl ?? 'not configured'} (${source})`);
  }
  const names = [...new Set([...Object.keys(before.publicHeaders), ...Object.keys(after.publicHeaders)])].sort();
  for (const name of names) {
    if (before.publicHeaders[name] === after.publicHeaders[name] && before.publicHeaderSources[name] === after.publicHeaderSources[name]) continue;
    const hint = review.publicHeaderHints[name];
    const source = after.publicHeaderSources[name];
    const inherited = source === 'template' ? 'inherits Provider default' : source === 'accountOverride' && review.scope === 'machine' ? 'inherits Account' : 'override';
    lines.push(`${name}: ${before.publicHeaders[name] ?? 'not set'} → ${after.publicHeaders[name] ?? 'not set'} (${inherited})${hint ? ` — ${text(hint)}` : ''}`);
  }
  if (review.authorityDescription) lines.push(text(review.authorityDescription));
  if (after.reason === 'endpoint_override_required') lines.push('Enter a Provider address before using this endpoint.');
  else if (after.reason === 'required_public_header_missing') lines.push('A required request header is missing.');
  else if (after.reason === 'local_candidate_required') lines.push('Select an endpoint on the Machine.');
  return lines.join('\n\n');
}

export function prepareProviderEndpointPolicyReviewFromViewV1(view: DaemonProviderConnectionViewV1, patch: PolicyPatch) {
  const endpoint = view.endpoints.find(candidate => candidate.endpointTemplateId === patch.endpointTemplateId);
  if (!endpoint) throw createProviderErrorV1('provider_connection_invalid', { connectionId: patch.connectionId });
  return prepareProviderEndpointPolicyReviewV1({ connectionId: view.connectionId, revision: view.revision, endpoint,
    authorityDescription: view.credential?.authorityDescription }, patch);
}
