import { filterRelayAccessProviderDescriptors, parseRelayAccessConfig, type BuiltinAccessProviderDefinition } from '@happier-dev/cli-common/relayAccess';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { AccessProviderSelectionV1Schema, type AccessProviderContributionV1,
    type AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { ResolvedAccessProviderContribution, ResolvedContributionRegistry } from './types';

export const accessProvidersProjectionFamily = definePluginProjectionFamilyV2({
    family: 'accessProviders',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'accessProviders',
        entriesById: Object.freeze(Object.fromEntries((registry.accessProviders ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
                definition: entry.definition, ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});

type ResolvedAccessProviderSelectionForHost =
    | Readonly<{ ok: true; kind: 'builtin'; selection: AccessProviderSelectionV1; definition: BuiltinAccessProviderDefinition }>
    | Readonly<{ ok: true; kind: 'plugin'; selection: AccessProviderSelectionV1; definition: AccessProviderContributionV1; contribution: ResolvedAccessProviderContribution }>
    | Readonly<{ ok: false; errorCode: 'access_provider_unavailable' | 'invalid_access_provider_selection' | 'access_provider_target_unsupported'; error: string }>;

/** Machine descriptor admission; legacy Home selection codecs are not activated here. */
export function resolveAccessProviderSelectionForHost(params: Readonly<{
    registry: ResolvedContributionRegistry;
    selection: AccessProviderSelectionV1;
    target: AccessProviderContributionV1['targets'][number];
}>): ResolvedAccessProviderSelectionForHost {
    const parsed = AccessProviderSelectionV1Schema.safeParse(params.selection);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_access_provider_selection', error: 'The access selection is invalid' };
    const selection = parsed.data;
    // Built-in Machine roles need the existing P20 descriptor-program ingress;
    // no synthetic plugin identity or Home-only native role is substituted.
    if ('kind' in selection.provider) {
        const builtinId = selection.provider.id;
        // Canonical build-policy filtering belongs to this resolver, as in the
        // existing outside generic conversion. Do not duplicate it in callers.
        const builtin = filterRelayAccessProviderDescriptors({
            allowTailscale: resolveCliFeatureDecision({ featureId: 'setup.relayAccess.allowTailscale', env: process.env }).state === 'enabled',
            allowCloudflareTunnel: resolveCliFeatureDecision({ featureId: 'setup.relayAccess.allowCloudflareTunnel', env: process.env }).state === 'enabled',
        }).find(entry => entry.id === builtinId);
        if (!builtin) return { ok: false, errorCode: 'access_provider_unavailable', error: 'access_provider_unavailable' };
        const admitted = parseRelayAccessConfig(selection, [builtin]);
        if (!admitted) return { ok: false, errorCode: 'invalid_access_provider_selection', error: 'invalid_access_provider_selection' };
        if (!builtin.definition.targets.includes(params.target)) return { ok: false, errorCode: 'access_provider_target_unsupported', error: 'access_provider_target_unsupported' };
        return { ok: true, kind: 'builtin', selection: admitted, definition: builtin.definition };
    }
    const contribution = params.registry.accessProvidersByContributionKey?.get(buildQualifiedPluginContributionKey(selection.provider));
    if (!contribution) return { ok: false, errorCode: 'access_provider_unavailable', error: 'The selected access provider is unavailable' };
    const definition = contribution.definition;
    const purposes = new Set(definition.credentialPurposes.map(entry => entry.purpose));
    if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(definition.configSchema), selection.config)
        || selection.credentialRefs.some(ref => !purposes.has(ref.purpose))) return {
        ok: false, errorCode: 'invalid_access_provider_selection', error: 'The access selection does not match its declared configuration and credential purposes' };
    if (!definition.targets.includes(params.target)) return { ok: false, errorCode: 'access_provider_target_unsupported', error: 'The access provider does not support this target' };
    return { ok: true, kind: 'plugin', selection, definition, contribution };
}
