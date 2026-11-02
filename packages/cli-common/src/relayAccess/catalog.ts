import { tailscaleMembershipPrograms } from './providers/tailscale/membership.js';
import type { BuiltinAccessProviderDefinition } from './types.js';
import { AccessProviderSelectionV1Schema, accessProviderRefsEqualV1, type AccessProviderContributionV1,
    type AccessProviderRefV1, type AccessCredentialPurposeRefV1 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { RelayAccessConfig, RelayAccessProviderDescriptor, RelayAccessProviderId } from './types.js';
export type { RelayAccessConfig, RelayAccessProviderDescriptor, RelayAccessProviderId, RelayAccessRemedyId } from './types.js';

type BuiltinDeclaration = Readonly<{
    id: string; title: string; exposure: AccessProviderContributionV1['exposure'];
    configSchema: AccessProviderContributionV1['configSchema']; homeAccessMethod?: AccessProviderContributionV1['homeAccessMethod'];
    requiresUpstreamUrl: boolean; prerequisites: RelayAccessProviderDescriptor['prerequisites'];
    homeSetupTaskKind?: 'secureAccess.tailscale.v1'; credentialPurposes?: AccessProviderContributionV1['credentialPurposes'];
    icon: AccessProviderContributionV1['icon']; homeUi?: RelayAccessProviderDescriptor['homeUi'];
    capabilities?: AccessProviderContributionV1['capabilities'];
    membership?: AccessProviderContributionV1['membership'];
    remedies?: RelayAccessProviderDescriptor['remedies'];
    targets: AccessProviderContributionV1['targets']; https?: AccessProviderContributionV1['https'];
}>;
const emptyConfig = { type: 'object', properties: {}, additionalProperties: false } as const;
const declarations: readonly BuiltinDeclaration[] = [
    { id: 'localOnly', title: 'Local only', exposure: 'local', homeAccessMethod: 'local_only', configSchema: emptyConfig,
        icon: 'lock', homeUi: { titleKey: 'settings.relayAccess.providers.localOnly.title', subtitleKey: 'settings.relayAccess.providers.localOnly.subtitle' },
        targets: ['homeRelay'], requiresUpstreamUrl: false, prerequisites: [] },
    { id: 'lan', title: 'LAN / custom URL', exposure: 'lan', homeAccessMethod: 'lan',
        icon: 'wifi-high', homeUi: { titleKey: 'settings.relayAccess.providers.lan.title', subtitleKey: 'settings.relayAccess.providers.lan.subtitle', configStep: {
            testIDPrefix: 'relay-access-lan', hintKey: 'setupOnboarding.relayAccessUrlBody', fields: [{ id: 'url', labelKey: 'settings.relayAccess.fields.urlLabel', placeholderKey: 'common.urlPlaceholder', format: 'url', settingKey: 'lanUrl' }],
        } },
        configSchema: { type: 'object', properties: { url: { type: 'string', minLength: 1 } }, required: ['url'], additionalProperties: false },
        targets: ['homeRelay'], requiresUpstreamUrl: false, prerequisites: [{ kind: 'manualUrl' }] },
    { id: 'tailscaleServe', title: 'Tailscale Serve', exposure: 'privateNetwork', homeAccessMethod: 'tailscale_serve', configSchema: emptyConfig,
        icon: 'shield-check', homeUi: { titleKey: 'settings.relayAccess.providers.tailscaleServe.title', subtitleKey: 'settings.relayAccess.providers.tailscaleServe.subtitle', buildPolicyFeatureId: 'setup.relayAccess.allowTailscale' },
        remedies: { reasons: { tailscale_not_installed: 'tailscale.install', tailscale_command_not_found: 'tailscale.install', tailscale_serve_approval_required: 'tailscale.serve.approve' }, needsAuth: 'tailscale.login', notConfigured: 'tailscale.serve.enable' },
        targets: ['domainRoute', 'homeRelay'], https: { hostname: 'providerAssigned', ports: [443], paths: true },
        requiresUpstreamUrl: true, homeSetupTaskKind: 'secureAccess.tailscale.v1', prerequisites: [{ kind: 'tailscaleInstalled' }, { kind: 'tailscaleAuth' }] },
    { id: 'tailscaleFunnel', title: 'Tailscale Funnel', exposure: 'public', homeAccessMethod: 'tailscale_funnel', configSchema: emptyConfig,
        icon: 'globe', homeUi: { titleKey: 'settings.relayAccess.providers.tailscaleFunnel.title', subtitleKey: 'settings.relayAccess.providers.tailscaleFunnel.subtitle', buildPolicyFeatureId: 'setup.relayAccess.allowTailscale' },
        remedies: { reasons: { tailscale_not_installed: 'tailscale.install', tailscale_command_not_found: 'tailscale.install', tailscale_funnel_approval_required: 'tailscale.funnel.approve' }, needsAuth: 'tailscale.login', missingShareUrl: 'tailscale.funnel.approve' },
        targets: ['domainRoute', 'homeRelay'], https: { hostname: 'providerAssigned', ports: [443], paths: true },
        requiresUpstreamUrl: true, homeSetupTaskKind: 'secureAccess.tailscale.v1', prerequisites: [{ kind: 'tailscaleInstalled' }, { kind: 'tailscaleAuth' }] },
    { id: 'cloudflareNamed', title: 'Cloudflare (named tunnel)', exposure: 'public', homeAccessMethod: 'cloudflare_tunnel',
        icon: 'cloud', homeUi: { titleKey: 'settings.relayAccess.providers.cloudflareNamed.title', subtitleKey: 'settings.relayAccess.providers.cloudflareNamed.subtitle', buildPolicyFeatureId: 'setup.relayAccess.allowCloudflareTunnel',
            credentialBindings: [{ purpose: 'tunnel.manage', kind: 'connectedAccount', service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, settingKey: 'cloudflareToken' }], configStep: {
            testIDPrefix: 'relay-access-cloudflare', hintKey: 'setupOnboarding.relayAccessCloudflareBody', fields: [{ id: 'hostname', labelKey: 'settings.relayAccess.fields.hostnameLabel', format: 'hostname', settingKey: 'cloudflareHostname' }],
        } },
        remedies: { notConfigured: 'cloudflare.configure' },
        configSchema: { type: 'object', properties: {
            hostname: { type: 'string', minLength: 1 },
            // Existing hostname-only Home selections remain readable. The
            // reviewed Domain selection carries the complete explicit leaf,
            // never inferred Cloudflare or connector image coordinates.
            controller: { type: 'object', additionalProperties: false, properties: {
                accountId: { type: 'string', minLength: 1 }, zoneId: { type: 'string', minLength: 1 },
                connector: { type: 'object', additionalProperties: false, properties: {
                    imageRef: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 },
                }, required: ['imageRef', 'version'] },
                tunnel: { oneOf: [
                    { type: 'object', additionalProperties: false, properties: {
                        kind: { const: 'create' }, name: { type: 'string', minLength: 1 },
                    }, required: ['kind', 'name'] },
                    { type: 'object', additionalProperties: false, properties: {
                        kind: { const: 'adopt' }, tunnelId: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
                    }, required: ['kind', 'tunnelId', 'name'] },
                ] },
                owned: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                    hostname: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, expectedService: { type: 'string', minLength: 1 },
                }, required: ['hostname', 'expectedService'] } },
                dnsOwnership: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                    hostname: { type: 'string', minLength: 1 }, recordId: { type: 'string', minLength: 1 },
                }, required: ['hostname', 'recordId'] } },
            }, required: ['accountId', 'zoneId', 'connector', 'tunnel', 'owned', 'dnsOwnership'] },
        }, required: ['hostname'], additionalProperties: false },
        targets: ['domainRoute', 'homeRelay'], https: { hostname: 'custom', ports: [443], paths: true },
        requiresUpstreamUrl: true, prerequisites: [{ kind: 'cloudflareHostname' }, { kind: 'credentialPurpose', purpose: 'tunnel.manage' }],
        credentialPurposes: [{ purpose: 'tunnel.manage', required: true }] },
    { id: 'tailscale', title: 'Tailscale', exposure: 'privateNetwork', configSchema: emptyConfig,
        icon: 'network', targets: ['machine'], capabilities: ['management', 'privateNetwork'],
        membership: tailscaleMembershipPrograms, requiresUpstreamUrl: false,
        prerequisites: [{ kind: 'tailscaleInstalled' }], credentialPurposes: [{ purpose: 'network.join', required: false }] },
    { id: 'caddy', title: 'Caddy', exposure: 'public', configSchema: emptyConfig,
        icon: 'globe', targets: ['machine', 'domainRoute'], capabilities: ['ingress'],
        // Actual HTTPS ports arrive only from the owned native listener observation.
        requiresUpstreamUrl: false, prerequisites: [] },
];

/** One declaration source projects the native codecs and pre-plugin Home subset. */
export const relayAccessProviderDescriptors: readonly RelayAccessProviderDescriptor[] = declarations.map(declaration => {
    const definition: BuiltinAccessProviderDefinition = {
        id: declaration.id, title: declaration.title, icon: declaration.icon, schemaVersion: 1,
        targets: declaration.targets, capabilities: declaration.capabilities ?? ['ingress'],
        exposure: declaration.exposure, configSchema: declaration.configSchema,
        ...(declaration.https ? { https: declaration.https } : {}), inboundPorts: [],
        credentialPurposes: declaration.credentialPurposes ?? [],
        actions: declaration.membership
            ? { inspect: 'machines.reachability.inspect', join: 'machines.reachability.configure', leave: 'machines.reachability.configure' }
            : { inspect: 'machines.reachability.inspect', configure: 'machines.reachability.configure', disable: 'machines.reachability.configure' },
        ...(declaration.homeAccessMethod ? { homeAccessMethod: declaration.homeAccessMethod } : {}),
        ...(declaration.membership ? { membership: declaration.membership } : {}),
    };
    return Object.freeze({ id: declaration.id, title: declaration.title, provider: { kind: 'builtin' as const, id: declaration.id }, definition,
        exposure: declaration.exposure === 'public' ? 'public' as const : 'private' as const,
        prerequisites: declaration.prerequisites, requiresUpstreamUrl: declaration.requiresUpstreamUrl,
        ...(declaration.homeUi ? { homeUi: declaration.homeUi } : {}),
        ...(declaration.remedies ? { remedies: declaration.remedies } : {}),
        ...(declaration.homeSetupTaskKind ? { homeSetupTaskKind: declaration.homeSetupTaskKind } : {}) });
});
export const relayAccessProviderIds: readonly string[] = relayAccessProviderDescriptors.map(descriptor => descriptor.id);
export const relayAccessProviderDescriptorsById: Readonly<Record<string, RelayAccessProviderDescriptor>> = Object.freeze(
    Object.fromEntries(relayAccessProviderDescriptors.map(descriptor => [descriptor.id, descriptor])),
);
export type RelayAccessBuildPolicy = Readonly<{ allowTailscale: boolean; allowCloudflareTunnel: boolean }>;
/** Build constraints are projected once from declarations, not re-decided by surfaces. */
export function filterRelayAccessProviderDescriptors(policy: RelayAccessBuildPolicy,
    descriptors: readonly RelayAccessProviderDescriptor[] = relayAccessProviderDescriptors): readonly RelayAccessProviderDescriptor[] {
    const allowed = {
        'setup.relayAccess.allowTailscale': policy.allowTailscale,
        'setup.relayAccess.allowCloudflareTunnel': policy.allowCloudflareTunnel,
    };
    return descriptors.filter(descriptor => !descriptor.homeUi?.buildPolicyFeatureId || allowed[descriptor.homeUi.buildPolicyFeatureId]);
}
export function getRelayAccessProviderDescriptor(provider: AccessProviderRefV1): RelayAccessProviderDescriptor {
    const descriptor = relayAccessProviderDescriptors.find(candidate => accessProviderRefsEqualV1(candidate.provider, provider));
    if (!descriptor) throw Object.assign(new Error('access_provider_unavailable'), { code: 'access_provider_unavailable' });
    return descriptor;
}
export type AccessProviderCatalogEntry = Readonly<{ provider: AccessProviderRefV1; definition: AccessProviderContributionV1 }>;

/** Structural parsing and closed descriptor config admission have one boundary. */
export function parseRelayAccessConfig(value: unknown, catalog: readonly AccessProviderCatalogEntry[] = relayAccessProviderDescriptors): RelayAccessConfig | null {
    const selection = AccessProviderSelectionV1Schema.safeParse(value);
    if (!selection.success) return null;
    const descriptor = catalog.find(entry => accessProviderRefsEqualV1(entry.provider, selection.data.provider));
    if (!descriptor || !isValidPluginJsonSchemaValue(compilePluginJsonSchema(descriptor.definition.configSchema), selection.data.config)) return null;
    const purposes = new Set(descriptor.definition.credentialPurposes.map(requirement => requirement.purpose));
    if (selection.data.credentialRefs.some(ref => !purposes.has(ref.purpose))) return null;
    return selection.data;
}
export function createBuiltinRelayAccessSelection(id: RelayAccessProviderId, config: RelayAccessConfig['config'] = {},
    credentialRefs: readonly AccessCredentialPurposeRefV1[] = []): RelayAccessConfig {
    const selection = parseRelayAccessConfig({ provider: { kind: 'builtin', id }, config, credentialRefs: [...credentialRefs] });
    if (!selection) throw Object.assign(new Error('invalid_access_provider_selection'), { code: 'invalid_access_provider_selection' });
    return selection;
}
/** A native/Home display key never grants installed-plugin authority. */
export function readBuiltinRelayAccessProviderId(provider: AccessProviderRefV1): string | null {
    return 'kind' in provider && provider.kind === 'builtin' && relayAccessProviderDescriptorsById[provider.id] ? provider.id : null;
}
