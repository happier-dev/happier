import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { validateInputTypeValue } from '@happier-dev/protocol/inputs/runtime';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { readInputPath, resolveEffectiveInputFields, isSameInputOptionValue } from '@happier-dev/protocol/inputs';
import { resolveConfiguredWidgetInputs, resolveConfiguredWidgetTargetInputV1, resolveWidgetViewerPurposeValuesV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, type WidgetInstanceV1, type WidgetSurfaceRefV1, type WidgetInputIssueV1 } from '@happier-dev/protocol/widgets';
import { readWidgetDescriptor, describeAuthoredWidgetDefinitionV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope, useProfile, useSetting, useSession } from '@/sync/domains/state/storage';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { resolveConfiguredWidgetTarget, withWidgetInputRepairOutcome, type ConfiguredWidgetTargetResolution } from './widgetBinding';
import { admitWidgetViewerSelectionMetadataV1 } from './widgetViewerSelectionAdmission';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { isSessionRouteHydrationPending } from '@/sync/domains/session/sessionRouteHydrationState';
import { getSessionName } from '@/utils/sessions/sessionUtils';

/** Physical placement supplies context; only the bound exact Session supplies execution facts. */
type ConfiguredWidgetTargetOptions = Readonly<{
    scope: WidgetSurfaceRefV1;
    instance: WidgetInstanceV1;
    descriptor: WidgetCandidate;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    appRuntime: PluginUiProjectionCurrentness;
    enabled?: boolean;
}>;

export function useConfiguredWidgetTarget(input: ConfiguredWidgetTargetOptions): ConfiguredWidgetTargetResolution {
    return withWidgetInputRepairOutcome(useConfiguredWidgetTargetFacts(input), { instance: input.instance, descriptor: input.descriptor });
}

function useConfiguredWidgetTargetFacts(input: ConfiguredWidgetTargetOptions): ConfiguredWidgetTargetResolution {
    const viewer = useActiveServerAccountScope();
    const profile = useProfile();
    const purposeBindings = useSetting('connectedAccountPurposeBindingsV1');
    const resolve = (descriptor: WidgetCandidate, runtime = input.appRuntime) => {
        const current = profile?.id === viewer?.accountId ? resolveWidgetViewerPurposeValuesV1({ instance: input.instance, descriptor,
            profile, purposeBindings, resources: Object.values(runtime.pluginUiProjection?.resourcesById ?? {}), now: Date.now(),
            readAuthentication: service => runtime.connectedAccountProjection?.kind === 'ready'
                ? runtime.connectedAccountProjection.descriptors.find(descriptor => descriptor.pluginId === service.pluginId && descriptor.id === service.localId
                    && descriptor.availability.state === 'available')?.authentication ?? null : null,
        }) : { values: {}, fields: [] };
        const resolved = resolveConfiguredWidgetInputs({ instance: input.instance, descriptor, providedContext: input.providedContext,
            viewerValues: current.values,
            validateValue: (field, value) => {
                if (input.instance.bindings[field.path]?.kind !== 'viewer' && !field.connectedAccountOptions) return { status: 'valid' };
                const selected = QualifiedConnectedAccountRefSchema.safeParse(value);
                if (!selected.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                if (!viewer) return { status: 'denied', reasonCode: 'widgets_viewer_scope_mismatch' };
                const refusal = admitWidgetViewerSelectionMetadataV1({ viewer,
                    ref: { surface: input.scope, instanceId: input.instance.id }, instance: input.instance,
                    descriptor: { ...descriptor, connectedAccountDescriptors: runtime.connectedAccountProjection?.kind === 'ready'
                        ? runtime.connectedAccountProjection.descriptors : [] }, profile,
                    values: { [field.path]: selected.data }, now: Date.now(), purposeBindings,
                    resources: Object.values(runtime.pluginUiProjection?.resourcesById ?? {}) });
                return refusal ? { status: 'denied', reasonCode: refusal.errorCode ?? 'widgets_viewer_selection_unavailable' } : { status: 'valid' };
            },
        });
        if (current.fields.length) {
            const fields = [...current.fields, ...(resolved.status === 'ready' ? [] : resolved.fields.filter(field => !current.fields.some(issue => issue.path === field.path)))];
            const status = (['denied', 'invalid', 'unavailable', 'selection_required'] as const).find(status => fields.some(field => field.status === status))!;
            return { status, fields };
        }
        return resolved;
    };
    const provisional = resolve(input.descriptor);
    const currentViewer = areServerAccountScopesEqual(viewer, input.scope);
    const builtin = input.instance.definition.kind === 'builtin';
    const currentDefinition = isSameWidgetDefinitionV1(input.instance.definition, widgetCandidateDefinitionV1(input.descriptor));
    const targetInput = resolveConfiguredWidgetTargetInputV1({ instance: input.instance, descriptor: input.descriptor,
        providedContext: input.providedContext, viewerValues: {} });
    const address = currentViewer && currentDefinition && input.enabled !== false && input.descriptor.sessionInputPath && targetInput.status === 'ready'
        ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(targetInput.input, input.descriptor.sessionInputPath)) : null;
    const requested = address?.success && address.data.serverId === input.scope.serverId ? address.data : null;
    const selectedSession = useSession(requested?.sessionId ?? '', requested?.serverId ?? input.scope.serverId);
    const selectedAccess = selectedSession?.access === undefined && selectedSession
        ? normalizeSessionAccessProjection({ share: selectedSession.accessLevel ? {
            accessLevel: selectedSession.accessLevel, canApprovePermissions: selectedSession.canApprovePermissions === true,
        } : null }, { allowLegacy: true }) : selectedSession?.access;
    const selectedIdentityMatches = requested !== null && selectedSession?.id === requested.sessionId && selectedSession.serverId === requested.serverId;
    const selectedCanRead = selectedIdentityMatches && selectedAccess?.capabilities.readTranscript === true;
    // A render-cache miss is not absence. Reuse the exact Session's route owner
    // without waking its transcript; denied cached targets are not hydrated.
    const hydrationAddress = requested && (!selectedSession || selectedCanRead) ? requested : null;
    const selectedHydration = useHydrateSessionForRoute(hydrationAddress?.sessionId ?? '', 'widgets.target.hydrate', {
        serverId: hydrationAddress?.serverId ?? input.scope.serverId,
        hydrateMessages: false,
    });
    const selectedRuntime = useSessionPluginRuntime({ address: !builtin && selectedCanRead ? requested : null });
    const authored = input.descriptor.authoredDefinition;
    const reference = input.instance.definition;
    const installed = input.descriptor.target === 'session' && requested && authored?.body.kind !== 'declarative'
        ? readWidgetDescriptor(selectedRuntime.pluginUiProjection, input.descriptor.sourceDefinition ?? reference)
        : input.descriptor;
    const candidate = authored && installed && (reference.kind === 'artifact' || reference.kind === 'inline')
        ? describeAuthoredWidgetDefinitionV1(authored, reference, authored.body.kind === 'installed' ? installed : null)
        : installed;
    const bound = candidate ? resolve(candidate, input.descriptor.target === 'session' && !builtin ? selectedRuntime : input.appRuntime) : provisional;
    const fields = bound.status === 'ready' ? resolveEffectiveInputFields({ inputHints: candidate?.inputs }, bound.input, { includeHidden: true }) : [];
    const consumer = { kind: 'widget' as const, surface: input.scope, definition: input.instance.definition,
        ...(requested ? { selectedSession: requested } : {}) };
    const draftInput = bound.status === 'ready' ? bound.input : {};
    const executableRuntime = input.descriptor.target === 'session' && !builtin ? selectedRuntime : input.appRuntime;
    const optionReads = useInputFieldOptions({
        enabled: input.enabled !== false && currentViewer && currentDefinition && bound.status === 'ready'
            && (builtin ? selectedCanRead : executableRuntime.phase === 'current' && executableRuntime.interactionEnabled),
        serverId: input.scope.serverId,
        machineId: input.descriptor.target === 'session' ? selectedRuntime.machineId : input.appRuntime.machineId,
        sessionId: requested?.sessionId,
        refreshKey: JSON.stringify(candidate?.inputs),
        // Native Session reads already admit this exact readable Session through
        // its owner. Rediscovering the whole Session list is not a data-read prerequisite.
        requests: fields.filter(field => (!builtin || field.path !== candidate?.sessionInputPath)
            && !(field.inputType && !field.options?.length && !field.optionsSourceId
                && executableRuntime.pluginUiProjection?.inputTypesById[buildQualifiedPluginContributionKey(field.inputType)]?.definition.options === undefined)
            && !(field.connectedAccountOptions && input.instance.bindings[field.path]?.kind === 'viewer'
                && !field.options?.length && !field.optionsSourceId && !field.inputType)).map(field => ({ field, consumer, draftInput })),
    });
    const sessionRefusal = (status: WidgetInputIssueV1['status'], reasonCode: string): ConfiguredWidgetTargetResolution => withWidgetInputRepairOutcome({ status, reasonCode,
        ...(input.descriptor.sessionInputPath ? { fields: [{ path: input.descriptor.sessionInputPath, status, reasonCode }] } : {}) }, {
            instance: input.instance, descriptor: input.descriptor,
            ...(selectedIdentityMatches && selectedSession ? { sessionLabel: getSessionName(selectedSession, requested.serverId) } : {}),
        });
    if (input.enabled === false) return { status: 'unavailable', reasonCode: 'widget_inactive' };
    if (!currentViewer) return { status: 'denied', reasonCode: 'widget_viewer_scope_mismatch' };
    if (!currentDefinition) return { status: 'unavailable', reasonCode: 'widget_type_unavailable' };
    if (requested && (!selectedSession || selectedCanRead) && isSessionRouteHydrationPending(selectedHydration))
        return { status: 'loading', reasonCode: 'widget_session_hydrating' };
    if (requested && !selectedSession) {
        if (selectedHydration.kind === 'missing' && selectedHydration.cause !== 'not_found')
            return sessionRefusal('denied', 'widget_session_access_denied');
        return sessionRefusal('unavailable', 'widget_session_unavailable');
    }
    if (requested && !selectedIdentityMatches) return sessionRefusal('denied', 'widget_target_identity_mismatch');
    if (requested && !selectedCanRead) return sessionRefusal('denied', 'widget_session_access_denied');
    // A readable bound Session is not an absent widget while its exact daemon
    // projection is still being established. Retained AppShell metadata names
    // the definition, but never supplies execution authority for that target.
    if (!candidate && provisional.status === 'ready') {
        return {
            status: 'unavailable',
            reasonCode: !builtin && requested && selectedRuntime.phase === 'establishing'
                ? 'widget_projection_establishing' : 'widget_type_unavailable',
        };
    }
    for (const field of fields) {
        if (builtin && field.path === candidate?.sessionInputPath) continue;
        const value = readInputPath(draftInput, field.path);
        if (value === undefined) continue;
        if (field.inputType) {
            const entry = executableRuntime.pluginUiProjection?.inputTypesById[buildQualifiedPluginContributionKey(field.inputType)];
            const refuse = (status: 'invalid' | 'unavailable', reasonCode: string): ConfiguredWidgetTargetResolution => ({ status, reasonCode,
                fields: [{ path: field.path, status, reasonCode }] });
            if (!entry?.occurrenceId || entry.pluginId !== field.inputType.pluginId || entry.definition.id !== field.inputType.localId)
                return refuse('unavailable', 'input_type_unavailable');
            const values = field.widget === 'multiselect' && Array.isArray(value) ? value : [value];
            for (const value of values) {
                const validation = validateInputTypeValue({ identity: field.inputType, occurrenceId: entry.occurrenceId, definition: entry.definition }, value);
                if (validation.status !== 'valid') return refuse('invalid', validation.reasonCode);
            }
            if (!entry.definition.options && !field.options?.length && !field.optionsSourceId) continue;
        }
        if (!field.options?.length && !field.optionsSourceId && !field.inputType && !field.connectedAccountOptions) continue;
        if (field.connectedAccountOptions && input.instance.bindings[field.path]?.kind === 'viewer'
            && !field.options?.length && !field.optionsSourceId && !field.inputType) continue;
        const state = optionReads.state(field, { consumer, draftInput });
        if (state.status !== 'ready') {
            const reasonCode = state.errorCode ?? 'widget_input_options_loading';
            return { status: 'unavailable', reasonCode, fields: [{ path: field.path, status: 'unavailable', reasonCode }] };
        }
        const values = field.widget === 'multiselect' && Array.isArray(value) ? value : [value];
        if (values.some(value => !state.options.some(option => option.disabled !== true && isSameInputOptionValue(option.value, value as JsonValue))))
            return { status: 'invalid', reasonCode: 'widget_input_option_unavailable', fields: [{ path: field.path, status: 'invalid', reasonCode: 'widget_input_option_unavailable' }] };
    }
    return resolveConfiguredWidgetTarget({
        scope: input.scope, definition: input.instance.definition, targetKind: input.descriptor.target,
        resolvedInput: bound,
        repairContext: { instance: input.instance, descriptor: candidate ?? input.descriptor, connection: { scope: input.scope,
            machineId: executableRuntime.phase === 'current' && executableRuntime.interactionEnabled ? executableRuntime.machineId : null,
            resources: Object.values(executableRuntime.pluginUiProjection?.resourcesById ?? {}) } },
        sessionInputPath: candidate?.sessionInputPath, appRuntime: input.appRuntime,
        readSession: ref => {
            if (!requested || requested.serverId !== ref.serverId || requested.sessionId !== ref.sessionId)
                return { status: 'denied', reasonCode: 'widget_target_identity_mismatch' };
            if (!selectedSession) return { status: 'unavailable', reasonCode: 'widget_session_unavailable' };
            if (!selectedCanRead)
                return { status: 'denied', reasonCode: 'widget_session_access_denied' };
            return { status: 'ready', session: selectedSession, runtime: builtin ? input.appRuntime : selectedRuntime };
        },
    });
}
