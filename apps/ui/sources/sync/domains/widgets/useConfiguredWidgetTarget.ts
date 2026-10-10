import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readInputFieldOptionsConstraint, validateInputFieldSchema, validateInputFieldValue } from '@happier-dev/protocol/inputs/runtime';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { readInputPath, resolveEffectiveInputFields, type InputFieldHint, type InputOption } from '@happier-dev/protocol/inputs';
import { readWidgetInputTargetV1, composeWidgetGroupContextV1, inheritWidgetGroupViewerBindingsV1, resolveConfiguredWidgetInputs, resolveConfiguredWidgetTargetInputV1, resolveWidgetViewerPurposeValuesV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSurfaceRefV1, type WidgetInputIssueV1 } from '@happier-dev/protocol/widgets';
import { readWidgetDescriptor, describeAuthoredWidgetDefinitionV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope, useProfile, useSession } from '@/sync/domains/state/storage';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { resolveConfiguredWidgetTarget, withWidgetInputRepairOutcome, type ConfiguredWidgetTargetResolution } from './widgetBinding';
import { admitWidgetViewerSelectionMetadataV1 } from './widgetViewerSelectionAdmission';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { isSessionRouteHydrationPending } from '@/sync/domains/session/sessionRouteHydrationState';
import { getSessionName } from '@/utils/sessions/sessionUtils';

const NO_PURPOSE_BINDINGS: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };

/** Physical placement supplies context; only the bound exact Session supplies execution facts. */
type ConfiguredWidgetTargetOptions = Readonly<{
    scope: WidgetSurfaceRefV1;
    admittedViewer?: ServerAccountScope;
    instance: WidgetInstanceV1;
    descriptor: WidgetCandidate;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    groupBindings?: WidgetInputBindingsV1;
    appRuntime: PluginUiProjectionCurrentness;
    enabled?: boolean;
}>;

export function useConfiguredWidgetTarget(input: ConfiguredWidgetTargetOptions): ConfiguredWidgetTargetResolution {
    input = { ...input, instance: inheritWidgetGroupViewerBindingsV1(input.instance, input.groupBindings, input.descriptor.inputs?.fields ?? []) };
    return withWidgetInputRepairOutcome(useConfiguredWidgetTargetFacts(input), { instance: input.instance, descriptor: input.descriptor });
}

function useConfiguredWidgetTargetFacts(input: ConfiguredWidgetTargetOptions): ConfiguredWidgetTargetResolution {
    const providedContext = composeWidgetGroupContextV1({ providedContext: input.providedContext, groupBindings: input.groupBindings });
    const targetDeclaration = readWidgetInputTargetV1(input.descriptor);
    const sessionPath = targetDeclaration.kind === 'session' ? targetDeclaration.path : undefined;
    const viewer = useActiveServerAccountScope();
    const profile = useProfile();
    const purposePaths = Object.entries(input.instance.bindings).filter(([path, binding]) => binding.kind === 'viewer'
        && input.descriptor.connectedAccountPurposeBindings?.some(declaration => declaration.path === path && declaration.purpose === binding.purpose)
        && input.descriptor.inputs?.fields.some(field => field.path === path && field.connectedAccountOptions === true)).map(([path]) => path);
    const needsPurposeCatalog = purposePaths.length > 0;
    const purposeCatalog = useConnectedAccountCatalog('purposes', needsPurposeCatalog ? viewer : null);
    const purposeCatalogReady = purposeCatalog.status === 'ready' && !purposeCatalog.stale && purposeCatalog.value !== null;
    // Empty is meaningful only for paths which do not consume viewer purposes.
    const purposeBindings = purposeCatalogReady ? purposeCatalog.value! : NO_PURPOSE_BINDINGS;
    const resolve = (descriptor: WidgetCandidate, runtime = input.appRuntime) => {
        const current = needsPurposeCatalog && !purposeCatalogReady ? { values: {}, fields: purposePaths.map(path => ({ path,
            status: 'unavailable' as const, reasonCode: 'connected_account_purpose_catalog_unavailable' })) }
            : profile?.id === viewer?.accountId ? resolveWidgetViewerPurposeValuesV1({ instance: input.instance, descriptor,
            profile, purposeBindings, resources: Object.values(runtime.pluginUiProjection?.resourcesById ?? {}), now: Date.now(),
            readAuthentication: service => runtime.connectedAccountProjection?.kind === 'ready'
                ? runtime.connectedAccountProjection.descriptors.find(descriptor => descriptor.pluginId === service.pluginId && descriptor.id === service.localId
                    && descriptor.availability.state === 'available')?.authentication ?? null : null,
        }) : { values: {}, fields: [] };
        const resolved = resolveConfiguredWidgetInputs({ instance: input.instance, descriptor, providedContext,
            viewerValues: current.values,
            validateValue: (field, value) => {
                if (input.instance.bindings[field.path]?.kind !== 'viewer' && !field.connectedAccountOptions) return { status: 'valid' };
                const selected = QualifiedConnectedAccountRefSchema.safeParse(value);
                if (!selected.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                if (!viewer) return { status: 'denied', reasonCode: 'widgets_viewer_scope_mismatch' };
                const refusal = admitWidgetViewerSelectionMetadataV1({ viewer,
                    admittedViewer: input.admittedViewer,
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
    const currentViewer = areServerAccountScopesEqual(viewer, input.scope)
        || input.scope.serverId === viewer?.serverId && areServerAccountScopesEqual(viewer, input.admittedViewer);
    const builtin = input.instance.definition.kind === 'builtin';
    const currentDefinition = isSameWidgetDefinitionV1(input.instance.definition, widgetCandidateDefinitionV1(input.descriptor));
    const targetInput = resolveConfiguredWidgetTargetInputV1({ instance: input.instance, descriptor: input.descriptor,
        providedContext, viewerValues: {} });
    const address = currentViewer && currentDefinition && input.enabled !== false && sessionPath && targetInput.status === 'ready'
        ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(targetInput.input, sessionPath)) : null;
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
    const installed = targetDeclaration.kind === 'session' && !builtin && requested && authored?.body.kind !== 'declarative'
        ? readWidgetDescriptor(selectedRuntime.pluginUiProjection, input.descriptor.sourceDefinition ?? reference)
        : input.descriptor;
    const candidate = authored && installed && (reference.kind === 'artifact' || reference.kind === 'inline')
        ? describeAuthoredWidgetDefinitionV1(authored, reference, authored.body.kind === 'installed' ? installed : null)
        : installed;
    const bound = candidate ? resolve(candidate, targetDeclaration.kind === 'session' && !builtin ? selectedRuntime : input.appRuntime) : provisional;
    const fields = bound.status === 'ready' ? resolveEffectiveInputFields({ inputHints: candidate?.inputs }, bound.input, { includeHidden: true }) : [];
    const consumer = { kind: 'widget' as const, surface: input.scope, definition: input.instance.definition,
        ...(requested ? { selectedSession: requested } : {}) };
    const draftInput = bound.status === 'ready' ? bound.input : {};
    const executableRuntime = targetDeclaration.kind === 'session' && !builtin ? selectedRuntime : input.appRuntime;
    const readInputType = (field: InputFieldHint) => {
        if (!field.inputType || !('pluginId' in field.inputType)) return undefined;
        const entry = executableRuntime.pluginUiProjection?.inputTypesById[buildQualifiedPluginContributionKey(field.inputType)];
        return entry?.occurrenceId ? { identity: { pluginId: entry.pluginId, localId: entry.definition.id },
            occurrenceId: entry.occurrenceId, definition: entry.definition } : null;
    };
    const optionReads = useInputFieldOptions({
        enabled: input.enabled !== false && currentViewer && currentDefinition && bound.status === 'ready'
            && (builtin ? targetDeclaration.kind !== 'session' || selectedCanRead : executableRuntime.phase === 'current' && executableRuntime.interactionEnabled),
        serverId: input.scope.serverId,
        machineId: targetDeclaration.kind === 'session' ? selectedRuntime.machineId : input.appRuntime.machineId,
        sessionId: requested?.sessionId,
        refreshKey: JSON.stringify(candidate?.inputs),
        // Exact native refs need discovery only when their consuming field declares it.
        requests: fields.filter(field => readInputFieldOptionsConstraint(field, readInputType(field),
            input.instance.bindings[field.path]?.kind === 'viewer').kind === 'dynamic').map(field => ({ field, consumer, draftInput })),
    });
    const sessionRefusal = (status: WidgetInputIssueV1['status'], reasonCode: string): ConfiguredWidgetTargetResolution => withWidgetInputRepairOutcome({ status, reasonCode,
        ...(sessionPath ? { fields: [{ path: sessionPath, status, reasonCode }] } : {}) }, {
            instance: input.instance, descriptor: input.descriptor,
            ...(selectedIdentityMatches && selectedSession ? { sessionLabel: getSessionName(selectedSession, requested.serverId) } : {}),
        });
    if (input.enabled === false) return { status: 'unavailable', reasonCode: 'widget_inactive' };
    if (!currentViewer) return { status: 'denied', reasonCode: 'widget_viewer_scope_mismatch' };
    if (!currentDefinition) return { status: 'unavailable', reasonCode: 'widget_type_unavailable' };
    if (needsPurposeCatalog && purposeCatalog.status === 'loading')
        return { status: 'loading', reasonCode: 'connected_account_purpose_catalog_loading' };
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
        const value = readInputPath(draftInput, field.path);
        if (value === undefined) continue;
        const type = readInputType(field);
        const refuse = (validation: Exclude<ReturnType<typeof validateInputFieldValue>, { status: 'valid' }>): ConfiguredWidgetTargetResolution => {
            const reasonCode = validation.reasonCode === 'input_type_option_invalid' ? 'widget_input_option_unavailable' : validation.reasonCode;
            return { status: validation.status, reasonCode, fields: [{ path: field.path, status: validation.status, reasonCode }] };
        };
        const schema = validateInputFieldSchema({ field, value: value as JsonValue, type });
        if (schema.status !== 'valid') return refuse(schema);
        const constraint = readInputFieldOptionsConstraint(field, type, input.instance.bindings[field.path]?.kind === 'viewer');
        let options: readonly InputOption[] | undefined;
        if (constraint.kind === 'dynamic') {
            const state = optionReads.state(field, { consumer, draftInput });
            if (state.status !== 'ready') {
                const reasonCode = state.errorCode ?? 'widget_input_options_loading';
                return { status: 'unavailable', reasonCode, fields: [{ path: field.path, status: 'unavailable', reasonCode }] };
            }
            options = state.options;
        }
        const admitted = validateInputFieldValue({ field, value: value as JsonValue, type, options,
            viewerPurpose: input.instance.bindings[field.path]?.kind === 'viewer' });
        if (admitted.status !== 'valid') return refuse(admitted);
    }
    return resolveConfiguredWidgetTarget({
        scope: input.scope, definition: input.instance.definition, targetKind: input.descriptor.target,
        authoredBody: candidate?.authoredDefinition?.body,
        resolvedInput: bound,
        repairContext: { instance: input.instance, descriptor: candidate ?? input.descriptor, connection: { scope: input.scope,
            machineId: executableRuntime.phase === 'current' && executableRuntime.interactionEnabled ? executableRuntime.machineId : null,
            resources: Object.values(executableRuntime.pluginUiProjection?.resourcesById ?? {}) } },
        descriptor: candidate ?? input.descriptor,
        providedContext: input.providedContext, appRuntime: input.appRuntime,
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
