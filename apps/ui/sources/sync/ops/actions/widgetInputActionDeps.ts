import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { readConnectedAccountCatalogInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { createWidgetActionInputResolverV1, composeWidgetGroupContextV1, findWidgetLayoutParentV1, readWidgetActionSurfacePortV1, WidgetSurfaceReadV1Schema, resolveConfiguredWidgetTargetInputV1, resolveWidgetViewerPurposeValuesV1, resolveWidgetConnectedAccountOptionsV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, type WidgetActionInputResolverV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { admitWidgetViewerSelectionMetadataV1 } from '@/sync/domains/widgets/widgetViewerSelectionAdmission';
import { readWidgetDescriptor, describeAuthoredWidgetDefinitionV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readWidgetActionRuntimeV1, readWidgetActionCandidatesV1 } from './widgetCatalogActionDeps';
import type { LazyActionAccountContext } from './actionAccountContext';
import { admitWidgetActionSurfaceV1 } from '@happier-dev/protocol/widgets';
import { readWidgetInputTargetV1, validateWidgetWorkspaceInputV1 } from '@happier-dev/protocol/widgets/widgetInputAdmissionV1';

const NO_PURPOSE_BINDINGS: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };

/** Host-local sharing review: the default executor retains credential and layout admission. */
export async function readWidgetShareInputDescriptorV1(input: Readonly<{
    ref: Parameters<WidgetActionInputResolverV1['resolve']>[0]['ref'];
    instance: Parameters<WidgetActionInputResolverV1['resolve']>[0]['instance'];
    scope: Readonly<{ serverId: string; accountId: string }>; signal?: AbortSignal;
}>) {
    return (await import('./defaultActionExecutor')).readDefaultWidgetShareInputDescriptorV1(input);
}

export function createWidgetInputActionDepsV1(account: LazyActionAccountContext | null | undefined, deps: ActionExecutorDeps): Pick<ActionExecutorDeps, 'widgetInputs' | 'widgetConnectedAccountOptions'> & Readonly<{
    readWidgetInputDescriptor?: (request: Parameters<WidgetActionInputResolverV1['resolve']>[0]) => Promise<WidgetCandidate | null>;
}> {
    if (!account) return {};
    const viewer = { serverId: account.serverId, accountId: account.accountId };
    const isCurrent = () => areServerAccountScopesEqual(getActiveServerAccountScope(), viewer)
        && (account.accountLifetime?.isCurrent() ?? true);
    const widgetConnectedAccountOptions: NonNullable<ActionExecutorDeps['widgetConnectedAccountOptions']> = async ({ consumer, fieldPath, context }) => {
        const unavailable = { ok: false as const, errorCode: 'widget_connected_account_options_unavailable', error: 'widget_connected_account_options_unavailable' };
        account.assertCurrent();
        if (!isCurrent()) return unavailable;
        const refusal = await admitWidgetActionSurfaceV1(deps, consumer.surface, context);
        if (refusal) return refusal;
        if (consumer.surface.owner.kind === 'sessionBoard') return { ok: false, errorCode: 'widgets_viewer_selection_unavailable', error: 'widgets_viewer_selection_unavailable' };
        const runtime = await readWidgetActionRuntimeV1(consumer.surface, account, context.signal, consumer.selectedSession, deps);
        if ('ok' in runtime) return runtime;
        const reference = consumer.definition;
        if (reference.kind === 'artifact' && consumer.surface.accountId !== account.accountId) return unavailable;
        const authored = reference.kind === 'inline' ? reference.definition
            : reference.kind === 'artifact' ? await deps.widgetDefinitionArtifacts?.get(reference.artifactId, context.signal) : null;
        if ((reference.kind === 'artifact' || reference.kind === 'inline') && !authored) return unavailable;
        const definition = authored?.body.kind === 'installed' ? authored.body : reference;
        const candidate = runtime.candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition));
        const descriptor = authored && (reference.kind === 'inline' || reference.kind === 'artifact')
            ? describeAuthoredWidgetDefinitionV1(authored, reference, candidate) : candidate;
        const profile = storage.getState().profile;
        account.assertCurrent();
        context.signal?.throwIfAborted();
        if (!runtime.isCurrent() || !descriptor || profile?.id !== account.accountId) return unavailable;
        return resolveWidgetConnectedAccountOptionsV1({ descriptor, resources: Object.values(runtime.projection?.resourcesById ?? {}),
            profile, path: fieldPath, now: Date.now() }) ?? unavailable;
    };
    const executor = createActionExecutor({ ...deps, widgetConnectedAccountOptions });
    type Request = Parameters<WidgetActionInputResolverV1['resolve']>[0];
    const descriptors = new WeakMap<Request, WidgetCandidate>();
    const groupBindings = new WeakMap<Request, Promise<WidgetInputBindingsV1 | undefined>>();
    const readGroupBindings = (request: Request) => {
        if (request.groupBindings !== undefined) return Promise.resolve(request.groupBindings);
        let pending = groupBindings.get(request);
        if (!pending) {
            pending = (async () => {
                account.assertCurrent();
                if (!isCurrent() || await admitWidgetActionSurfaceV1(deps, request.ref.surface, { ...request.context, signal: request.signal })) return undefined;
                const port = readWidgetActionSurfacePortV1(deps, request.ref.surface);
                if (!port) return undefined;
                const read = WidgetSurfaceReadV1Schema.safeParse(await port.read(request.ref.surface, request.context, request.signal));
                account.assertCurrent();
                request.signal?.throwIfAborted();
                return isCurrent() && read.success && sameStrictJsonValue(read.data.surface, request.ref.surface)
                    ? findWidgetLayoutParentV1(read.data.items ?? [], request.ref.instanceId)?.context : undefined;
            })();
            groupBindings.set(request, pending);
        }
        return pending;
    };
    const readContext = (request: Request): Readonly<Record<string, readonly JsonValue[]>> => {
        account.assertCurrent();
        const owner = request.ref.surface.owner;
        if (request.context.widgetAreaContext && sameStrictJsonValue(request.context.widgetAreaContext.surface, request.ref.surface)) return request.context.widgetAreaContext.values;
        return owner.kind === 'sessionBoard' || owner.kind === 'companion'
            ? { session: [{ serverId: request.ref.surface.serverId, sessionId: owner.sessionId }] } : {};
    };
    const readProvidedContext = async (request: Request) => composeWidgetGroupContextV1({ providedContext: readContext(request), groupBindings: await readGroupBindings(request) });
    const purposeCatalogs = new WeakMap<Request, ReturnType<typeof readConnectedAccountCatalogInContext>>();
    const purposePaths = (request: Request, descriptor: WidgetCandidate) => Object.entries(request.instance.bindings)
        .filter(([path, binding]) => binding.kind === 'viewer'
            && descriptor.connectedAccountPurposeBindings?.some(declaration => declaration.path === path && declaration.purpose === binding.purpose)
            && descriptor.inputs?.fields.some(field => field.path === path && field.connectedAccountOptions === true)).map(([path]) => path);
    const readPurposeBindings = async (request: Request, descriptor: WidgetCandidate) => {
        if (purposePaths(request, descriptor).length === 0) return NO_PURPOSE_BINDINGS;
        let pending = purposeCatalogs.get(request);
        if (!pending) {
            pending = readConnectedAccountCatalogInContext(account, 'purposes', request.signal);
            purposeCatalogs.set(request, pending);
        }
        const catalog = await pending;
        account.assertCurrent();
        request.signal?.throwIfAborted();
        return isCurrent() && catalog.status === 'ready' && catalog.record.key === 'purposes' ? catalog.record.value : null;
    };
    const readViewerValues = async (request: Request, descriptor = descriptors.get(request)) => {
        if (!descriptor) return { values: {} };
        const purposeBindings = await readPurposeBindings(request, descriptor);
        const state = storage.getState();
        if (!isCurrent() || !descriptor || state.profile?.id !== account.accountId) return { values: {} };
        if (!purposeBindings) return { values: {}, fields: purposePaths(request, descriptor).map(path => ({ path,
            status: 'unavailable' as const, reasonCode: 'connected_account_purpose_catalog_unavailable' })) };
        return resolveWidgetViewerPurposeValuesV1({ instance: request.instance, descriptor, profile: state.profile,
            purposeBindings,
            resources: descriptor.resourceDeclarations ?? [], now: Date.now(), readAuthentication: service => descriptor.connectedAccountDescriptors?.find(candidate =>
                candidate.pluginId === service.pluginId && candidate.id === service.localId && candidate.availability.state === 'available')?.authentication ?? null });
    };
    const readDescriptor = async (request: Request) => {
            account.assertCurrent();
            if (!isCurrent() || await admitWidgetActionSurfaceV1(deps, request.ref.surface, { ...request.context, signal: request.signal })) return null;
            if (request.instance.definition.kind === 'builtin') {
                const candidate = readWidgetDescriptor(null, request.instance.definition);
                if (candidate) descriptors.set(request, candidate);
                return candidate;
            }
            const reference = request.instance.definition;
            if (reference.kind === 'artifact' && request.ref.surface.accountId !== account.accountId) return null;
            const authored = reference.kind === 'inline' ? reference.definition
                : reference.kind === 'artifact' ? await deps.widgetDefinitionArtifacts?.get(reference.artifactId, request.signal) : null;
            account.assertCurrent();
            if ((reference.kind === 'artifact' || reference.kind === 'inline') && !authored) return null;
            if (authored?.body.kind === 'declarative' && (reference.kind === 'artifact' || reference.kind === 'inline')) {
                const descriptor = describeAuthoredWidgetDefinitionV1(authored, reference);
                const targetDeclaration = readWidgetInputTargetV1(descriptor);
                if (targetDeclaration.kind === 'invalid') return null;
                const targetInput = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor,
                    providedContext: await readProvidedContext(request), viewerValues: {} });
                const selected = targetDeclaration.kind === 'session' && targetInput.status === 'ready'
                    ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(targetInput.input, targetDeclaration.path)) : null;
                if (targetDeclaration.kind === 'session' && (!selected?.success || selected.data.serverId !== account.serverId)) return descriptor;
                const runtime = await readWidgetActionRuntimeV1(request.ref.surface, account, request.signal, selected?.success ? selected.data : undefined, deps);
                account.assertCurrent();
                if ('ok' in runtime || !runtime.isCurrent()) return null;
                const hydrated = { ...descriptor, connectedAccountDescriptors: runtime.connectedAccountDescriptors ?? [],
                    resourceDeclarations: Object.values(runtime.projection?.resourcesById ?? {}).filter(resource =>
                    descriptor.resources?.some(ref => ref.pluginId === resource.pluginId && ref.localId === resource.id)) };
                descriptors.set(request, hydrated);
                return hydrated;
            }
            const candidates = await readWidgetActionCandidatesV1(request.ref.surface, account, request.signal, undefined, deps);
            if ('ok' in candidates) return null;
            const definition = authored?.body.kind === 'installed' ? authored.body : reference;
            const matches = (candidate: typeof candidates[number]) => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition);
            let candidate = candidates.find(matches);
            if (!candidate) {
                // Account inventory supplies declaration metadata only. A widget
                // absent from physical A must still be admitted by bound B below.
                const metadata = readWidgetDescriptor(readCurrentAppShellPluginUiProjection(), definition);
                if (metadata && readWidgetInputTargetV1(metadata).kind === 'session') candidate = metadata;
            }
            const targetDeclaration = candidate ? readWidgetInputTargetV1(candidate) : null;
            if (targetDeclaration?.kind === 'invalid') return null;
            if (candidate && targetDeclaration?.kind === 'session') {
                const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor: candidate,
                    providedContext: await readProvidedContext(request), viewerValues: (await readViewerValues(request, candidate)).values });
                const target = bound.status === 'ready' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, targetDeclaration.path)) : null;
                if (target?.success && target.data.serverId === account.serverId) {
                    const current = await readWidgetActionCandidatesV1(request.ref.surface, account, request.signal, target.data, deps);
                    const currentCandidate = 'ok' in current ? undefined : current.find(matches);
                    candidate = currentCandidate && sameStrictJsonValue(readWidgetInputTargetV1(currentCandidate), targetDeclaration) ? currentCandidate : undefined;
                }
            }
            if (candidate && authored && (reference.kind === 'artifact' || reference.kind === 'inline')) {
                if (!sameStrictJsonValue(readWidgetInputTargetV1(candidate), readWidgetInputTargetV1(authored))) return null;
                candidate = describeAuthoredWidgetDefinitionV1(authored, reference, candidate);
            }
            if (candidate) descriptors.set(request, candidate);
            return candidate ?? null;
    };
    const widgetInputs = createWidgetActionInputResolverV1({
        readInputType: async (field, request) => {
            if (!field.inputType || 'hostType' in field.inputType) return null;
            const descriptor = descriptors.get(request);
            if (!descriptor) return null;
            const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor,
                providedContext: await readProvidedContext(request), viewerValues: (await readViewerValues(request)).values });
            const targetDeclaration = readWidgetInputTargetV1(descriptor);
            if (targetDeclaration.kind === 'invalid') return null;
            const selected = targetDeclaration.kind === 'session' && bound.status === 'ready'
                ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, targetDeclaration.path)) : null;
            const runtime = await readWidgetActionRuntimeV1(request.ref.surface, account, request.signal, selected?.success ? selected.data : undefined, deps);
            if ('ok' in runtime || !runtime.isCurrent()) return null;
            const entry = runtime.projection?.inputTypesById[buildQualifiedPluginContributionKey(field.inputType)];
            return entry?.occurrenceId && entry.pluginId === field.inputType.pluginId && entry.definition.id === field.inputType.localId
                ? { identity: field.inputType, occurrenceId: entry.occurrenceId, definition: entry.definition } : null;
        },
        readDescriptor,
        readGroupBindings,
        readContext: async request => readContext(request),
        readViewerValues: async request => readViewerValues(request),
        validateValue: async (field, value, request) => {
            account.assertCurrent();
            if (request.instance.bindings[field.path]?.kind === 'viewer' || field.connectedAccountOptions) {
                const authority = await admitWidgetActionSurfaceV1(deps, request.ref.surface, { ...request.context, signal: request.signal });
                if (authority) return { status: 'denied', reasonCode: authority.errorCode };
                const selection = QualifiedConnectedAccountRefSchema.safeParse(value);
                if (!selection.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                const descriptor = descriptors.get(request);
                const purposeBindings = descriptor && request.instance.bindings[field.path]?.kind === 'viewer'
                    ? await readPurposeBindings(request, descriptor) : NO_PURPOSE_BINDINGS;
                if (!purposeBindings) return { status: 'unavailable', reasonCode: 'connected_account_purpose_catalog_unavailable' };
                const refusal = !descriptor || !isCurrent()
                    ? { ok: false as const, errorCode: 'widgets_surface_unavailable', error: 'widgets_surface_unavailable' }
                    : admitWidgetViewerSelectionMetadataV1({ viewer, admittedViewer: viewer, ref: request.ref, instance: request.instance, descriptor,
                        profile: storage.getState().profile, values: { [field.path]: selection.data }, now: Date.now(),
                        purposeBindings, resources: descriptor.resourceDeclarations ?? [] });
                return refusal ? { status: refusal.errorCode === 'widget_viewer_purpose_authority_unavailable' ? 'unavailable' : 'denied',
                    reasonCode: refusal.errorCode ?? 'widgets_viewer_selection_unavailable' } : { status: 'valid' };
            }
            const descriptor = descriptors.get(request);
            const targetDeclaration = descriptor ? readWidgetInputTargetV1(descriptor) : null;
            if (targetDeclaration?.kind === 'invalid') return { status: 'unavailable', reasonCode: targetDeclaration.reasonCode };
            if (targetDeclaration?.kind === 'workspace' && targetDeclaration.path === field.path) {
                return validateWidgetWorkspaceInputV1({ value, serverId: account.serverId,
                    contextValues: readContext(request)[targetDeclaration.path] ?? [] });
            }
            if (targetDeclaration?.kind !== 'session' || targetDeclaration.path !== field.path) return { status: 'valid' };
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
            const descriptor = descriptors.get(request);
            const targetDeclaration = descriptor ? readWidgetInputTargetV1(descriptor) : null;
            const selected = targetDeclaration?.kind === 'session' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(input, targetDeclaration.path)) : null;
            const result = await executor.execute('action.options.resolve', { consumer: { kind: 'widget', surface: request.ref.surface, definition: request.instance.definition,
                ...(selected?.success ? { selectedSession: selected.data } : {}) },
                fieldPath: field.path, draftInput: input }, { ...request.context, ...(request.signal ? { signal: request.signal } : {}) });
            account.assertCurrent();
            if (!result.ok) return { status: result.errorCode === 'credential_scope_denied' ? 'denied' : 'unavailable', reasonCode: result.errorCode ?? 'widget_input_options_unavailable' };
            return (getActionSpec('action.options.resolve').outputSchema!.parse(result.result) as PublicActionResultById['action.options.resolve']).options;
        },
    });
    return { widgetInputs, widgetConnectedAccountOptions, readWidgetInputDescriptor: readDescriptor };
}
