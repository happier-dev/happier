import { buildQualifiedPluginContributionKey, createActionExecutor, getActionSpec, VoiceTrackedSessionAddressV1Schema, type ActionExecutorDeps, type JsonValue, type PublicActionResultById } from '@happier-dev/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createWidgetActionInputResolverV1, resolveConfiguredWidgetTargetInputV1, resolveWidgetViewerPurposeValuesV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, type WidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { sameStrictJsonValue } from '@happier-dev/protocol';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { admitWidgetViewerSelectionMetadataV1 } from '@/sync/domains/widgets/widgetViewerSelectionAdmission';
import { readWidgetDescriptor, describeAuthoredWidgetDefinitionV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readWidgetActionRuntimeV1, readWidgetActionCandidatesV1 } from './widgetCatalogActionDeps';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createWidgetInputActionDepsV1(account: LazyActionAccountContext | null | undefined, deps: ActionExecutorDeps): Pick<ActionExecutorDeps, 'widgetInputs'> {
    if (!account) return {};
    const viewer = { serverId: account.serverId, accountId: account.accountId };
    const isCurrent = () => areServerAccountScopesEqual(getActiveServerAccountScope(), viewer)
        && (account.accountLifetime?.isCurrent() ?? true);
    const executor = createActionExecutor(deps);
    type Request = Parameters<WidgetActionInputResolverV1['resolve']>[0];
    const descriptors = new WeakMap<Request, WidgetCandidate>();
    const readContext = (request: Request): Readonly<Record<string, readonly JsonValue[]>> => {
        account.assertCurrent();
        const owner = request.ref.surface.owner;
        if (request.context.widgetAreaContext && sameStrictJsonValue(request.context.widgetAreaContext.surface, request.ref.surface)) return request.context.widgetAreaContext.values;
        return owner.kind === 'sessionBoard' || owner.kind === 'companion'
            ? { session: [{ serverId: request.ref.surface.serverId, sessionId: owner.sessionId }] } : {};
    };
    const readViewerValues = (request: Request, descriptor = descriptors.get(request)) => {
        const state = storage.getState();
        if (!isCurrent() || !descriptor || state.profile?.id !== account.accountId) return { values: {} };
        return resolveWidgetViewerPurposeValuesV1({ instance: request.instance, descriptor, profile: state.profile,
            purposeBindings: state.settings.connectedAccountPurposeBindingsV1,
            resources: descriptor.resourceDeclarations ?? [], now: Date.now(), readAuthentication: service => descriptor.connectedAccountDescriptors?.find(candidate =>
                candidate.pluginId === service.pluginId && candidate.id === service.localId && candidate.availability.state === 'available')?.authentication ?? null });
    };
    const readDescriptor = async (request: Request) => {
            account.assertCurrent();
            if (!isCurrent() || request.ref.surface.serverId !== account.serverId || request.ref.surface.accountId !== account.accountId) return null;
            if (request.instance.definition.kind === 'builtin') {
                const candidate = readWidgetDescriptor(null, request.instance.definition);
                if (candidate) descriptors.set(request, candidate);
                return candidate;
            }
            const reference = request.instance.definition;
            const authored = reference.kind === 'inline' ? reference.definition
                : reference.kind === 'artifact' ? await deps.widgetDefinitionArtifacts?.get(reference.artifactId, request.signal) : null;
            account.assertCurrent();
            if ((reference.kind === 'artifact' || reference.kind === 'inline') && !authored) return null;
            if (authored?.body.kind === 'declarative' && (reference.kind === 'artifact' || reference.kind === 'inline')) {
                const descriptor = describeAuthoredWidgetDefinitionV1(authored, reference);
                const targetInput = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor,
                    providedContext: readContext(request), viewerValues: {} });
                const selected = descriptor.sessionInputPath && targetInput.status === 'ready'
                    ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(targetInput.input, descriptor.sessionInputPath)) : null;
                if (descriptor.sessionInputPath && (!selected?.success || selected.data.serverId !== account.serverId)) return descriptor;
                const runtime = await readWidgetActionRuntimeV1(request.ref.surface, account, request.signal, selected?.success ? selected.data : undefined);
                account.assertCurrent();
                if ('ok' in runtime || !runtime.isCurrent()) return null;
                const hydrated = { ...descriptor, connectedAccountDescriptors: runtime.connectedAccountDescriptors ?? [],
                    resourceDeclarations: Object.values(runtime.projection?.resourcesById ?? {}).filter(resource =>
                    descriptor.resources?.some(ref => ref.pluginId === resource.pluginId && ref.localId === resource.id)) };
                descriptors.set(request, hydrated);
                return hydrated;
            }
            const candidates = await readWidgetActionCandidatesV1(request.ref.surface, account, request.signal);
            if ('ok' in candidates) return null;
            const definition = authored?.body.kind === 'installed' ? authored.body : reference;
            const matches = (candidate: typeof candidates[number]) => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition);
            let candidate = candidates.find(matches);
            if (!candidate) {
                // Account inventory supplies declaration metadata only. A widget
                // absent from physical A must still be admitted by bound B below.
                const metadata = readWidgetDescriptor(readCurrentAppShellPluginUiProjection(), definition);
                if (metadata?.target === 'session' && metadata.sessionInputPath) candidate = metadata;
            }
            if (candidate?.sessionInputPath) {
                const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor: candidate,
                    providedContext: readContext(request), viewerValues: readViewerValues(request, candidate).values });
                const target = bound.status === 'ready' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, candidate.sessionInputPath)) : null;
                if (target?.success && target.data.serverId === account.serverId) {
                    const current = await readWidgetActionCandidatesV1(request.ref.surface, account, request.signal, target.data);
                    const currentCandidate = 'ok' in current ? undefined : current.find(matches);
                    candidate = currentCandidate?.sessionInputPath === candidate.sessionInputPath ? currentCandidate : undefined;
                }
            }
            if (candidate && authored && (reference.kind === 'artifact' || reference.kind === 'inline')) {
                if (candidate.sessionInputPath !== authored.sessionInputPath) return null;
                candidate = describeAuthoredWidgetDefinitionV1(authored, reference, candidate);
            }
            if (candidate) descriptors.set(request, candidate);
            return candidate ?? null;
    };
    const widgetInputs = createWidgetActionInputResolverV1({
        readInputType: async (field, request) => {
            if (!field.inputType) return null;
            const descriptor = descriptors.get(request);
            if (!descriptor) return null;
            const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor,
                providedContext: readContext(request), viewerValues: readViewerValues(request).values });
            const selected = descriptor.sessionInputPath && bound.status === 'ready'
                ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, descriptor.sessionInputPath)) : null;
            const runtime = await readWidgetActionRuntimeV1(request.ref.surface, account, request.signal, selected?.success ? selected.data : undefined);
            if ('ok' in runtime || !runtime.isCurrent()) return null;
            const entry = runtime.projection?.inputTypesById[buildQualifiedPluginContributionKey(field.inputType)];
            return entry?.occurrenceId && entry.pluginId === field.inputType.pluginId && entry.definition.id === field.inputType.localId
                ? { identity: field.inputType, occurrenceId: entry.occurrenceId, definition: entry.definition } : null;
        },
        readDescriptor,
        readContext: async request => readContext(request),
        readViewerValues: async request => readViewerValues(request),
        validateValue: async (field, value, request) => {
            account.assertCurrent();
            if (request.instance.bindings[field.path]?.kind === 'viewer' || field.connectedAccountOptions) {
                const selection = QualifiedConnectedAccountRefSchema.safeParse(value);
                if (!selection.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                const descriptor = descriptors.get(request);
                const refusal = !descriptor || !isCurrent()
                    ? { ok: false as const, errorCode: 'widgets_surface_unavailable', error: 'widgets_surface_unavailable' }
                    : admitWidgetViewerSelectionMetadataV1({ viewer, ref: request.ref, instance: request.instance, descriptor,
                        profile: storage.getState().profile, values: { [field.path]: selection.data }, now: Date.now(),
                        purposeBindings: storage.getState().settings.connectedAccountPurposeBindingsV1, resources: descriptor.resourceDeclarations ?? [] });
                return refusal ? { status: refusal.errorCode === 'widget_viewer_purpose_authority_unavailable' ? 'unavailable' : 'denied',
                    reasonCode: refusal.errorCode ?? 'widgets_viewer_selection_unavailable' } : { status: 'valid' };
            }
            if (descriptors.get(request)?.sessionInputPath !== field.path) return { status: 'valid' };
            const address = VoiceTrackedSessionAddressV1Schema.safeParse(value);
            if (!address.success) return { status: 'invalid', reasonCode: 'widget_session_selection_invalid' };
            if (address.data.serverId !== account.serverId) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
            const read = await sync.withSessionSystemRecordRuntime(address.data, async runtime => {
                account.assertCurrent();
                request.signal?.throwIfAborted();
                return runtime.isCurrent() && runtime.session.access?.capabilities.readTranscript === true;
            });
            return read.status === 'ok' && read.value ? { status: 'valid' } : { status: 'denied', reasonCode: 'widget_session_access_denied' };
        },
        resolveOptions: async (field, input, request) => {
            const sessionPath = descriptors.get(request)?.sessionInputPath;
            const selected = sessionPath ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(input, sessionPath)) : null;
            const result = await executor.execute('action.options.resolve', { consumer: { kind: 'widget', surface: request.ref.surface, definition: request.instance.definition,
                ...(selected?.success ? { selectedSession: selected.data } : {}) },
                fieldPath: field.path, draftInput: input }, { ...request.context, ...(request.signal ? { signal: request.signal } : {}) });
            account.assertCurrent();
            if (!result.ok) return { status: result.errorCode === 'credential_scope_denied' ? 'denied' : 'unavailable', reasonCode: result.errorCode ?? 'widget_input_options_unavailable' };
            return (getActionSpec('action.options.resolve').outputSchema!.parse(result.result) as PublicActionResultById['action.options.resolve']).options;
        },
    });
    return { widgetInputs };
}
