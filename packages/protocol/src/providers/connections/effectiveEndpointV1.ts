import type { ProviderEndpointTemplateV1 } from '../contributions/v1.js';
import type { ProviderConnectionV1, ProviderEndpointOverrideV1 } from './v1.js';
import { ProviderEndpointOverrideV1Schema } from './v1.js';
import { normalizeProviderEndpointUrlSyntax } from '../safety/url.js';
import { normalizeProviderPublicHeaders } from '../safety/headers.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
import { compareProviderCanonicalStringsV1 } from '../canonicalOrderV1.js';

type Endpoint = Pick<ProviderEndpointTemplateV1, 'id' | 'protocol' | 'baseUrl' | 'localUrlCandidates' | 'requiresEndpointOverride' | 'addressConstraint' | 'requiredPublicHeaders' | 'publicHeaders'>;
type HeaderSource = 'template' | 'accountOverride' | 'machineOverride';
export type EffectiveProviderEndpointV1 = Readonly<{
  baseUrl: string | null;
  defaultBaseUrl: string | null;
  accountOverrideBaseUrl: string | null;
  machineOverrideBaseUrl: string | null;
  effectiveSource: HeaderSource;
  publicHeaders: Readonly<Record<string, string>>;
  defaultPublicHeaders: Readonly<Record<string, string>>;
  accountOverridePublicHeaders: Readonly<Record<string, string>> | null;
  machineOverridePublicHeaders: Readonly<Record<string, string>> | null;
  publicHeaderSources: Readonly<Record<string, HeaderSource>>;
  ready: boolean;
  reason: 'endpoint_override_required' | 'local_candidate_required' | 'required_public_header_missing' | null;
}>;

/** The syntax, family and policy owner. No secret, DNS or network work happens here. */
export function resolveEffectiveProviderEndpointV1(input: Readonly<{
  connection: Pick<ProviderConnectionV1, 'endpointOverrides' | 'endpointOverridesByMachineId'>;
  template: Endpoint;
  machineId?: string;
  selectedLocalCandidateUrl?: string;
}>): EffectiveProviderEndpointV1 {
  const { connection, template } = input;
  const account = connection.endpointOverrides?.find(value => value.endpointTemplateId === template.id);
  const machine = input.machineId ? readOwnRecordValue(connection.endpointOverridesByMachineId, input.machineId)?.find(value => value.endpointTemplateId === template.id) : undefined;
  const defaultPublicHeaders = normalizeProviderPublicHeaders(template.publicHeaders ?? {});
  const accountOverridePublicHeaders = account?.publicHeaders ? normalizeProviderPublicHeaders(account.publicHeaders) : null;
  const machineOverridePublicHeaders = machine?.publicHeaders ? normalizeProviderPublicHeaders(machine.publicHeaders) : null;
  const publicHeaders = { ...defaultPublicHeaders, ...accountOverridePublicHeaders, ...machineOverridePublicHeaders };
  const publicHeaderSources: Record<string, HeaderSource> = {};
  for (const name of Object.keys(defaultPublicHeaders)) publicHeaderSources[name] = 'template';
  for (const name of Object.keys(accountOverridePublicHeaders ?? {})) publicHeaderSources[name] = 'accountOverride';
  for (const name of Object.keys(machineOverridePublicHeaders ?? {})) publicHeaderSources[name] = 'machineOverride';
  const normalize = (value: string | undefined) => value === undefined ? null : normalizeProviderEndpointUrlSyntax(value).normalizedUrl;
  let candidate = machine?.baseUrl === undefined && account?.baseUrl === undefined ? input.selectedLocalCandidateUrl : undefined;
  if (candidate !== undefined) {
    candidate = normalizeProviderEndpointUrlSyntax(candidate).normalizedUrl;
    if (!template.localUrlCandidates?.includes(candidate)) throw new TypeError('Selected local endpoint is not declared');
  }
  const defaultBaseUrl = normalize(template.baseUrl ?? candidate ?? (template.localUrlCandidates?.length === 1 ? template.localUrlCandidates[0] : undefined));
  const accountOverrideBaseUrl = normalize(account?.baseUrl);
  const machineOverrideBaseUrl = normalize(machine?.baseUrl);
  const baseUrl = machineOverrideBaseUrl ?? accountOverrideBaseUrl ?? defaultBaseUrl;
  if (baseUrl && template.addressConstraint) {
    const url = new URL(baseUrl);
    const segments = url.pathname === '/' ? [] : url.pathname.slice(1).split('/');
    const constraint = template.addressConstraint;
    if (url.origin !== constraint.origin || url.search || url.hash || /%(?:2f|5c)/iu.test(url.pathname)
      || segments.length !== constraint.pathSegments.length || segments.some((segment, index) => {
        const decoded = decodeURIComponent(segment);
        return !decoded || /[\\/]/u.test(decoded) || (constraint.pathSegments[index] !== null && decoded !== constraint.pathSegments[index]);
      })) throw new TypeError('Provider endpoint address does not match its declared family');
  }
  const reason = !baseUrl ? template.requiresEndpointOverride ? 'endpoint_override_required' : 'local_candidate_required'
    : template.requiredPublicHeaders?.some(name => !publicHeaders[name]?.trim()) ? 'required_public_header_missing' : null;
  return { baseUrl, defaultBaseUrl, accountOverrideBaseUrl, machineOverrideBaseUrl,
    effectiveSource: machineOverrideBaseUrl ? 'machineOverride' : accountOverrideBaseUrl ? 'accountOverride' : 'template',
    publicHeaders, defaultPublicHeaders, accountOverridePublicHeaders, machineOverridePublicHeaders, publicHeaderSources,
    ready: reason === null, reason };
}

/** Independent patch/reset operands; removing a header override restores inheritance. */
export function patchProviderEndpointOverrideV1(values: readonly ProviderEndpointOverrideV1[] | undefined,
  input: Readonly<{ endpointTemplateId: string; baseUrl?: string | null; publicHeaders?: Readonly<Record<string, string>> | null }>): ProviderEndpointOverrideV1[] {
  const previous = values?.find(value => value.endpointTemplateId === input.endpointTemplateId);
  const baseUrl = input.baseUrl === undefined ? previous?.baseUrl : input.baseUrl ?? undefined;
  const publicHeaders = input.publicHeaders === undefined ? previous?.publicHeaders
    : input.publicHeaders === null ? undefined : normalizeProviderPublicHeaders(input.publicHeaders);
  const next = (values ?? []).filter(value => value.endpointTemplateId !== input.endpointTemplateId);
  if (baseUrl !== undefined || (publicHeaders && Object.keys(publicHeaders).length > 0)) {
    next.push(ProviderEndpointOverrideV1Schema.parse({ endpointTemplateId: input.endpointTemplateId,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(publicHeaders && Object.keys(publicHeaders).length > 0 ? { publicHeaders } : {}) }));
  }
  return next.sort((left, right) => compareProviderCanonicalStringsV1(left.endpointTemplateId, right.endpointTemplateId));
}
