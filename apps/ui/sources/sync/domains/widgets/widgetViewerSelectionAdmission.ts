import { sameQualifiedConnectedAccountRef, isQualifiedConnectedAccountProfileActiveV4,
    type ActionExecuteFailure, type AccountProfile, type ConnectedAccountUiProjectionEntryV1, type PluginContributionIdentityV1, type PluginProjectedResourceV2, type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { QualifiedConnectedAccountRefSchema, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { resolveWidgetViewerPurposeValuesV1, isSameWidgetDefinitionV1, type WidgetDefinitionRefV1, type WidgetInputDescriptorV1, type WidgetInstanceRefV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

/** Current Account metadata admits personal pins; viewer bindings require the existing purpose selection. */
export function admitWidgetViewerSelectionMetadataV1(input: Readonly<{
    viewer: ServerAccountScope;
    ref: WidgetInstanceRefV1;
    instance: WidgetInstanceV1;
    descriptor: WidgetInputDescriptorV1 & Readonly<{ surface?: PluginContributionIdentityV1; definition?: WidgetDefinitionRefV1;
        resources?: readonly PluginContributionIdentityV1[]; connectedAccountDescriptors?: readonly ConnectedAccountUiProjectionEntryV1[] }>;
    profile: AccountProfile | null;
    values: Readonly<Record<string, QualifiedConnectedAccountRef>>;
    now: number;
    purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
    resources?: readonly PluginProjectedResourceV2[];
}>): ActionExecuteFailure | null {
    const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    if (!areServerAccountScopesEqual(input.viewer, input.ref.surface) || input.profile?.id !== input.viewer.accountId)
        return failure('widgets_viewer_scope_mismatch');
    const definition = input.instance.definition;
    const described = input.descriptor.definition ?? (input.descriptor.surface ? { kind: 'installed' as const, surface: input.descriptor.surface } : null);
    if (input.ref.instanceId !== input.instance.id || !described || !isSameWidgetDefinitionV1(definition, described))
        return failure('widgets_viewer_field_invalid');
    const current = resolveWidgetViewerPurposeValuesV1({ instance: input.instance, descriptor: input.descriptor, profile: input.profile,
        purposeBindings: input.purposeBindings ?? { v: 1, bindings: [] }, resources: input.resources ?? [], now: input.now,
        readAuthentication: service => input.descriptor.connectedAccountDescriptors?.find(candidate => candidate.pluginId === service.pluginId
            && candidate.id === service.localId && candidate.availability.state === 'available')?.authentication ?? null });
    for (const [path, value] of Object.entries(input.values)) {
        const binding = input.instance.bindings[path];
        if (binding?.kind === 'value' && input.descriptor.inputs?.fields.some(field => field.path === path && field.connectedAccountOptions)) {
            const parsed = QualifiedConnectedAccountRefSchema.safeParse(value);
            const pinned = QualifiedConnectedAccountRefSchema.safeParse(binding.value);
            if (input.ref.surface.owner.kind === 'sessionBoard' || !parsed.success || !pinned.success
                || !sameQualifiedConnectedAccountRef(pinned.data, parsed.data)
                || !input.profile.connectedAccountsV4.some(account => sameQualifiedConnectedAccountRef(account.ref, parsed.data)
                    && isQualifiedConnectedAccountProfileActiveV4(account, input.now)))
                return failure('widgets_viewer_selection_unavailable');
            continue;
        }
        if (binding?.kind !== 'viewer' || !input.descriptor.inputs?.fields.some(field => field.path === path)
            || !input.descriptor.connectedAccountPurposeBindings?.some(declaration => declaration.path === path && declaration.purpose === binding.purpose))
            return failure('widgets_viewer_field_invalid');
        const parsed = QualifiedConnectedAccountRefSchema.safeParse(value);
        const selected = current.values[path];
        if (!parsed.success || !selected || !sameQualifiedConnectedAccountRef(selected, parsed.data))
            return failure(current.fields.find(field => field.path === path)?.reasonCode ?? 'widgets_viewer_selection_unavailable');
    }
    return null;
}
