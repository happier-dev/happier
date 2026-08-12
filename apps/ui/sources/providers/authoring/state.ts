import {
    normalizeCustomProviderAdvancedTemplateV1,
    normalizeCustomProviderTemplateV1,
    type ProviderCatalogParserV1,
    type CustomProviderCredentialStyleV1,
    type CustomProviderSimpleFormV1,
    type CustomProviderTemplateV1,
} from '@happier-dev/protocol';

export type CustomProviderPreset = CustomProviderSimpleFormV1['protocol'];

export type CustomProviderAdvancedEndpointDraft = Readonly<{
    protocol: CustomProviderPreset;
    enabled: boolean;
    baseUrl: string;
    requiresApiKey: boolean;
    credentialStyle: CustomProviderCredentialStyleV1;
    credentialHeader: string;
    publicHeadersText: string;
    probePathsText: string;
    probeParser: ProviderCatalogParserV1;
}>;

export type CustomProviderDraft = Readonly<{
    name: string;
    protocol: CustomProviderPreset;
    baseUrl: string;
    requiresApiKey: boolean;
    credentialStyle: CustomProviderCredentialStyleV1;
    credentialHeader: string;
    catalog: 'manual' | 'probe';
    modelsPath: string;
    advanced: boolean;
    endpoints: readonly CustomProviderAdvancedEndpointDraft[];
    manualModelsText: string;
}>;

const CUSTOM_PROTOCOLS: readonly CustomProviderPreset[] = ['openai-responses', 'openai-chat', 'anthropic'];

function endpointDraft(protocol: CustomProviderPreset, enabled: boolean, baseUrl = ''): CustomProviderAdvancedEndpointDraft {
    const defaults = protocolDefaults(protocol);
    return {
        protocol,
        enabled,
        baseUrl,
        requiresApiKey: true,
        credentialStyle: defaults.credentialStyle,
        credentialHeader: '',
        publicHeadersText: protocol === 'anthropic' ? 'anthropic-version: 2023-06-01' : '',
        probePathsText: defaults.modelsPath,
        probeParser: protocol === 'anthropic' ? 'anthropic-models' : 'openai-models',
    };
}

function protocolDefaults(protocol: CustomProviderPreset): Pick<
    CustomProviderDraft,
    'protocol' | 'credentialStyle' | 'catalog' | 'modelsPath'
> {
    if (protocol === 'anthropic') {
        return {
            protocol,
            credentialStyle: 'x-api-key',
            catalog: 'probe',
            modelsPath: '/v1/models?limit=1000',
        };
    }
    return { protocol, credentialStyle: 'bearer', catalog: 'probe', modelsPath: '/v1/models' };
}

export function createCustomProviderDraft(protocol: CustomProviderPreset): CustomProviderDraft {
    const defaults = protocolDefaults(protocol);
    return {
        name: '',
        baseUrl: '',
        requiresApiKey: true,
        credentialHeader: '',
        ...defaults,
        advanced: false,
        endpoints: CUSTOM_PROTOCOLS.map((candidate) => endpointDraft(candidate, candidate === protocol)),
        manualModelsText: '',
    };
}

export function updateCustomProviderDraftPreset(
    draft: CustomProviderDraft,
    protocol: CustomProviderPreset,
): CustomProviderDraft {
    const defaults = protocolDefaults(protocol);
    return {
        ...draft,
        ...defaults,
        endpoints: CUSTOM_PROTOCOLS.map((candidate) => endpointDraft(
            candidate,
            candidate === protocol,
            candidate === protocol ? draft.baseUrl : '',
        )),
    };
}

function parsePublicHeaders(value: string): Readonly<Record<string, string>> {
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    const names = new Set<string>();
    for (const [index, rawLine] of value.split(/\r?\n/u).entries()) {
        const line = rawLine.trim();
        if (!line) continue;
        const separator = line.indexOf(':');
        if (separator <= 0 || !line.slice(separator + 1).trim()) {
            throw new TypeError(`Public header line ${index + 1} must use Name: Value`);
        }
        const name = line.slice(0, separator).trim();
        const normalizedName = name.toLowerCase();
        if (names.has(normalizedName)) throw new TypeError(`Duplicate public header: ${name}`);
        names.add(normalizedName);
        result[name] = line.slice(separator + 1).trim();
    }
    return result;
}

export function buildCustomProviderTemplate(draft: CustomProviderDraft): CustomProviderTemplateV1 {
    if (draft.advanced) {
        const endpoints = draft.endpoints.filter((endpoint) => endpoint.enabled);
        return normalizeCustomProviderAdvancedTemplateV1({
            name: draft.name,
            endpoints: endpoints.map((endpoint) => ({
                protocol: endpoint.protocol,
                baseUrl: endpoint.baseUrl,
                ...(endpoint.publicHeadersText.trim()
                    ? { publicHeaders: parsePublicHeaders(endpoint.publicHeadersText) }
                    : {}),
                ...(endpoint.requiresApiKey ? {
                    credentialStyle: endpoint.credentialStyle,
                    ...(endpoint.credentialStyle === 'custom-header' || endpoint.credentialStyle === 'custom-header-bearer'
                        ? { credentialHeader: endpoint.credentialHeader }
                        : {}),
                } : {}),
            })),
            probes: endpoints.flatMap((endpoint) => endpoint.probePathsText
                .split(/\r?\n/u)
                .map((path) => path.trim())
                .filter(Boolean)
                .map((path) => ({ protocol: endpoint.protocol, path, parser: endpoint.probeParser }))),
        });
    }
    return normalizeCustomProviderTemplateV1({
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        ...(draft.requiresApiKey ? {
            credentialStyle: draft.credentialStyle,
            ...(draft.credentialStyle === 'custom-header' || draft.credentialStyle === 'custom-header-bearer'
                ? { credentialHeader: draft.credentialHeader }
                : {}),
        } : {}),
        catalog: draft.catalog,
        ...(draft.catalog === 'probe' ? { modelsPath: draft.modelsPath } : {}),
    });
}
