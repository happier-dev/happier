import { type ActionExecuteFailure} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WidgetViewerProfileV1 } from '@happier-dev/protocol/widgets';
import { type ConnectedAccountUiProjectionEntryV1} from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { type PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import { type PluginProjectedResourceV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { QualifiedConnectedAccountRefSchema, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { isWidgetConnectedAccountSelectionEligibleV1, resolveWidgetViewerPurposeValuesV1, isSameWidgetDefinitionV1, type WidgetDefinitionRefV1, type WidgetInputDescriptorV1, type WidgetInstanceRefV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Current Account metadata admits personal pins; viewer bindings require the existing purpose selection. */
export function admitWidgetViewerSelectionMetadataV1(input: Readonly<{
    viewer: ServerAccountScope;
    /** The host's actual layout admission, never the stored owner's identity rewritten as actor. */
    admittedViewer?: ServerAccountScope;
    ref: WidgetInstanceRefV1;
    instance: WidgetInstanceV1;
    descriptor: WidgetInputDescriptorV1 & Readonly<{ surface?: PluginContributionIdentityV1; definition?: WidgetDefinitionRefV1;
        resources?: readonly PluginContributionIdentityV1[]; connectedAccountDescriptors?: readonly ConnectedAccountUiProjectionEntryV1[] }>;
    profile: WidgetViewerProfileV1 | null;
    values: Readonly<Record<string, QualifiedConnectedAccountRef>>;
    now: number;
    purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
    resources?: readonly PluginProjectedResourceV2[];
}>): ActionExecuteFailure | null {
    const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    if ((!areServerProfileIdentifiersEquivalent(input.viewer.serverId, input.ref.surface.serverId)
        || input.viewer.accountId !== input.ref.surface.accountId && !areServerAccountScopesEqual(input.viewer, input.admittedViewer))
        || input.profile?.id !== input.viewer.accountId)
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
        const field = input.descriptor.inputs?.fields.find(field => field.path === path);
        if (binding?.kind === 'value' && field?.connectedAccountOptions) {
            const parsed = QualifiedConnectedAccountRefSchema.safeParse(value);
            if (!parsed.success || !isWidgetConnectedAccountSelectionEligibleV1({ field, binding, surface: input.ref.surface,
                selection: parsed.data, viewerValues: current.values, profile: input.profile, now: input.now }))
                return failure('widgets_viewer_selection_unavailable');
            continue;
        }
        if (binding?.kind !== 'viewer' || !field
            || !input.descriptor.connectedAccountPurposeBindings?.some(declaration => declaration.path === path && declaration.purpose === binding.purpose))
            return failure('widgets_viewer_field_invalid');
        const parsed = QualifiedConnectedAccountRefSchema.safeParse(value);
        if (!parsed.success || !isWidgetConnectedAccountSelectionEligibleV1({ field, binding, surface: input.ref.surface,
            selection: parsed.data, viewerValues: current.values, profile: input.profile, now: input.now }))
            return failure(current.fields.find(field => field.path === path)?.reasonCode ?? 'widgets_viewer_selection_unavailable');
    }
    return null;
}
