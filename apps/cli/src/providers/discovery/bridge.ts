import {
  normalizeProviderEndpointUrlSyntax,
  type ProviderContributionV1,
  type ProviderEndpointOverrideV1,
} from '@happier-dev/protocol';

/**
 * Converts one revalidated listener candidate into machine-scoped overrides
 * without losing the distinct base paths declared by each wire protocol.
 */
export function buildProviderDiscoveryEndpointOverrides(input: Readonly<{
  contribution: ProviderContributionV1;
  endpointTemplateId: string;
  normalizedEndpointUrl: string;
}>): readonly ProviderEndpointOverrideV1[] {
  const discovery = input.contribution.discovery;
  if (!discovery || discovery.availabilityProbe.endpointTemplateId !== input.endpointTemplateId) {
    throw new TypeError('Detected provider must reference the declared discovery availability endpoint');
  }
  const availabilityEndpoint = input.contribution.endpointTemplates.find(
    (endpoint) => endpoint.id === input.endpointTemplateId,
  );
  const declaredAvailabilityUrl = availabilityEndpoint?.localUrlCandidates?.[0];
  if (!declaredAvailabilityUrl) {
    throw new TypeError('Detected provider availability endpoint must have local URL candidates');
  }
  const candidate = new URL(normalizeProviderEndpointUrlSyntax(
    input.normalizedEndpointUrl,
    { allowQuery: false },
  ).normalizedUrl);
  const declared = new URL(declaredAvailabilityUrl);
  if (candidate.pathname !== declared.pathname) {
    throw new TypeError('Detected provider candidate endpoint path does not match the declared availability endpoint');
  }
  return input.contribution.endpointTemplates.map((endpoint) => {
    const local = endpoint.localUrlCandidates?.[0];
    if (!local) throw new TypeError('Detected provider endpoint must declare a local URL candidate');
    const target = new URL(local);
    target.protocol = candidate.protocol;
    target.hostname = candidate.hostname;
    target.port = candidate.port;
    return {
      endpointTemplateId: endpoint.id,
      baseUrl: normalizeProviderEndpointUrlSyntax(target.toString(), { allowQuery: false }).normalizedUrl,
    };
  });
}
