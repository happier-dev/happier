import { hasValidPluginConnectedAccountPurposeBindingsV2 } from '../plugins/actions/v2.js';
import type { PluginProjectedResourceV2 } from '../daemon/contributionRegistryProjection.js';
import type { AccountProfile } from '../account/profile.js';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '../connect/connectedAccountPurposeBindings.js';
import { resolveConnectedAccountPurposeSelectedAccountV1 } from '../connect/connectedAccountPurposeSelectionV1.js';
import type { PluginConnectedAccountAuthenticationV2 } from '../connect/pluginConnectedAccountAuthenticationV2.js';
import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import type { QualifiedConnectedAccountRef } from '../connect/qualifiedConnectedAccountPersistence.js';
import { WidgetConnectedAccountPurposeBindingV1Schema, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetInputIssueV1, WidgetInstanceV1 } from './widgetInstanceV1.js';

export type WidgetViewerPurposeResolutionV1 = Readonly<{
    values: Readonly<Record<string, QualifiedConnectedAccountRef>>;
    fields: readonly WidgetInputIssueV1[];
}>;

/** Correlate declared reads with the existing viewer-owned purpose selection. */
export function resolveWidgetViewerPurposeValuesV1(input: Readonly<{
    instance: WidgetInstanceV1;
    descriptor: WidgetInputDescriptorV1 & Readonly<{ resources?: readonly PluginContributionIdentityV1[] }>;
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
    profile: AccountProfile;
    resources: readonly PluginProjectedResourceV2[];
    readAuthentication?(service: PluginContributionIdentityV1): PluginConnectedAccountAuthenticationV2 | null;
    now: number;
}>): WidgetViewerPurposeResolutionV1 {
    const values: Record<string, QualifiedConnectedAccountRef> = {};
    const fields: WidgetInputIssueV1[] = [];
    for (const [path, binding] of Object.entries(input.instance.bindings)) {
        if (binding.kind !== 'viewer') continue;
        const declarations = input.descriptor.connectedAccountPurposeBindings ?? [];
        const mapping = declarations.filter(mapping => mapping.path === path && mapping.purpose === binding.purpose);
        const declaredField = input.descriptor.inputs?.fields.some(field => field.path === path && field.connectedAccountOptions === true);
        const parsed = mapping.length === 1 ? WidgetConnectedAccountPurposeBindingV1Schema.safeParse(mapping[0]) : null;
        const declaration = parsed?.success ? parsed.data : undefined;
        const resource = declaration && input.descriptor.resources?.some(resource => resource.pluginId === declaration.consumer.pluginId
            && resource.localId === declaration.consumer.localId)
            ? input.resources.find(resource => resource.pluginId === declaration.consumer.pluginId && resource.id === declaration.consumer.localId) : undefined;
        const purposes = resource?.connectedAccountPurposes?.filter(purpose => purpose.purpose === binding.purpose) ?? [];
        if (!declaredField || !declaration || purposes.length !== 1
            || !hasValidPluginConnectedAccountPurposeBindingsV2(input.descriptor.inputSchema, declarations)) {
            fields.push({ path, status: 'unavailable', reasonCode: 'widget_viewer_purpose_undeclared' });
            continue;
        }
        const purpose = { consumer: declaration.consumer, purpose: declaration.purpose };
        const account = resolveConnectedAccountPurposeSelectedAccountV1({ purpose, serviceRefs: purposes[0]!.serviceRefs,
            bindings: input.purposeBindings, accounts: input.profile.connectedAccountsV4, groups: input.profile.connectedAccountGroupsV4,
            readAuthentication: input.readAuthentication, now: input.now });
        if (!account) {
            fields.push({ path, status: 'selection_required', reasonCode: 'widget_viewer_connection_missing' });
            continue;
        }
        values[path] = account.ref;
    }
    return { values, fields };
}
