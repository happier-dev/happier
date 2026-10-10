import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { ActionExecutorDeps, ActionExecutorContext, AccountProfile, ConnectedAccountUiProjectionEntryV1, PluginContributionIdentityV1, PluginProjectedResourceV2, QualifiedConnectedAccountPurposeBindingsV1, JsonValue, PublicActionResultById } from '@happier-dev/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { readBuiltinWidgetDescriptorV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { readWidgetDefinitionResourcesV1 } from '@happier-dev/protocol/widgets/widgetDefinitionV1';
import { createWidgetActionInputResolverV1, composeWidgetGroupContextV1 } from '@happier-dev/protocol/widgets/widgetActionInputResolverV1';
import { readWidgetInputTargetV1, resolveConfiguredWidgetTargetInputV1, validateWidgetWorkspaceInputV1 } from '@happier-dev/protocol/widgets/widgetInputAdmissionV1';
import { isWidgetConnectedAccountSelectionEligibleV1, resolveWidgetViewerPurposeValuesV1, resolveWidgetConnectedAccountOptionsV1 } from '@happier-dev/protocol/widgets/widgetViewerPurposeV1';
import { findWidgetLayoutParentV1, readWidgetActionSurfacePortV1, WidgetSurfaceReadV1Schema, type WidgetInputBindingsV1, type WidgetCandidateIdentityV1, type WidgetActionInputResolverV1, type WidgetInputDescriptorV1 } from '@happier-dev/protocol/widgets';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { admitWidgetActionSurfaceV1 } from '@happier-dev/protocol/widgets';

type Request = Parameters<WidgetActionInputResolverV1['resolve']>[0];
type Descriptor = WidgetInputDescriptorV1 & Readonly<{ resources?: readonly PluginContributionIdentityV1[]; resourceDeclarations?: readonly PluginProjectedResourceV2[];
    connectedAccountDescriptors?: readonly ConnectedAccountUiProjectionEntryV1[] }>;
type Candidate = Descriptor & WidgetCandidateIdentityV1 & Readonly<{ availability: 'available' | 'unavailable' | 'denied' }>;

/** Host-specific transport reads feed the same binding/schema/options owner used by the UI. */
export function createCliWidgetInputActionDepsV1(input: Readonly<{
    serverId: string;
    accountId: string | null;
    getDeps(): ActionExecutorDeps;
    readCandidates(signal?: AbortSignal, session?: Readonly<{ serverId: string; sessionId: string }>): Promise<readonly Candidate[]>;
    readResources?(signal?: AbortSignal, session?: Readonly<{ serverId: string; sessionId: string }>): Promise<Readonly<{
        resources: readonly PluginProjectedResourceV2[]; connectedAccountDescriptors: readonly ConnectedAccountUiProjectionEntryV1[] }>>;
    readViewerPurposeContext?(signal: AbortSignal | undefined, context: ActionExecutorContext): Promise<Readonly<{ profile: AccountProfile; purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 }> | null>;
    validateSession(session: Readonly<{ serverId: string; sessionId: string }>, signal?: AbortSignal): Promise<boolean>;
}>): Pick<ActionExecutorDeps, 'widgetInputs' | 'widgetConnectedAccountOptions'> {
    const descriptors = new WeakMap<Request, Descriptor>();
    const groupBindings = new WeakMap<Request, Promise<WidgetInputBindingsV1 | undefined>>();
    const readGroupBindings = (request: Request) => {
        if (request.groupBindings !== undefined) return Promise.resolve(request.groupBindings);
        let pending = groupBindings.get(request);
        if (!pending) {
            pending = (async () => {
                if (!input.accountId || await admitWidgetActionSurfaceV1(input.getDeps(), request.ref.surface, { ...request.context, signal: request.signal })) return undefined;
                const port = readWidgetActionSurfacePortV1(input.getDeps(), request.ref.surface);
                if (!port) return undefined;
                const read = WidgetSurfaceReadV1Schema.safeParse(await port.read(request.ref.surface, request.context, request.signal));
                request.signal?.throwIfAborted();
                return read.success && sameStrictJsonValue(read.data.surface, request.ref.surface)
                    ? findWidgetLayoutParentV1(read.data.items ?? [], request.ref.instanceId)?.context : undefined;
            })();
            groupBindings.set(request, pending);
        }
        return pending;
    };
    const readViewerPurpose = async (request: Request, descriptor = descriptors.get(request)):
        Promise<ReturnType<typeof resolveWidgetViewerPurposeValuesV1> | null> => {
        if (!descriptor || !input.accountId || await admitWidgetActionSurfaceV1(input.getDeps(), request.ref.surface, { ...request.context, signal: request.signal })) return null;
        if (!Object.values(request.instance.bindings).some(binding => binding.kind === 'viewer')) return { values: {}, fields: [] };
        const current = await input.readViewerPurposeContext?.(request.signal, request.context);
        request.signal?.throwIfAborted();
        if (!current) return { values: {}, fields: Object.entries(request.instance.bindings).flatMap(([path, binding]) =>
            binding.kind === 'viewer' ? [{ path, status: 'unavailable' as const, reasonCode: 'widget_viewer_purpose_authority_unavailable' }] : []) };
        if (current.profile.id !== input.accountId) return null;
        return resolveWidgetViewerPurposeValuesV1({ ...current, instance: request.instance, descriptor,
            resources: descriptor.resourceDeclarations ?? [], now: Date.now(), readAuthentication: service => descriptor.connectedAccountDescriptors?.find(candidate =>
                candidate.pluginId === service.pluginId && candidate.id === service.localId && candidate.availability.state === 'available')?.authentication ?? null });
    };
    const readContext = (request: Request): Readonly<Record<string, readonly JsonValue[]>> => {
        const area = request.context.widgetAreaContext;
        if (area && sameStrictJsonValue(area.surface, request.ref.surface)) return area.values;
        const owner = request.ref.surface.owner;
        return owner.kind === 'sessionBoard' || owner.kind === 'companion'
            ? { session: [{ serverId: request.ref.surface.serverId, sessionId: owner.sessionId }] } : {};
    };
    const readProvidedContext = async (request: Request) => composeWidgetGroupContextV1({ providedContext: readContext(request), groupBindings: await readGroupBindings(request) });
    return { widgetConnectedAccountOptions: async ({ consumer, fieldPath, context }) => {
        const unavailable = { ok: false as const, errorCode: 'widget_connected_account_options_unavailable', error: 'widget_connected_account_options_unavailable' };
        if (!input.accountId) return unavailable;
        const refusal = await admitWidgetActionSurfaceV1(input.getDeps(), consumer.surface, context);
        if (refusal) return refusal;
        if (consumer.surface.owner.kind === 'sessionBoard') return { ok: false, errorCode: 'widgets_viewer_selection_unavailable', error: 'widgets_viewer_selection_unavailable' };
        const reference = consumer.definition;
        if (reference.kind === 'artifact' && consumer.surface.accountId !== input.accountId) return unavailable;
        const authored = reference.kind === 'inline' ? reference.definition
            : reference.kind === 'artifact' ? await input.getDeps().widgetDefinitionArtifacts?.get(reference.artifactId, context.signal) : null;
        if ((reference.kind === 'inline' || reference.kind === 'artifact') && !authored) return unavailable;
        const definition = authored?.body.kind === 'installed' ? authored.body : reference;
        const candidate = (await input.readCandidates(context.signal, consumer.selectedSession)).find(candidate => candidate.availability === 'available'
            && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition));
        const resources = authored?.body.kind === 'declarative' ? await input.readResources?.(context.signal, consumer.selectedSession) : null;
        const descriptor: Descriptor | undefined = authored?.body.kind === 'declarative'
            ? { ...authored, resources: readWidgetDefinitionResourcesV1(authored), resourceDeclarations: resources?.resources ?? [] }
            : candidate && (authored ? { ...candidate, sizeDeclaration: authored.sizeDeclaration, inputs: authored.inputs, inputSchema: authored.inputSchema,
                connectedAccountPurposeBindings: authored.connectedAccountPurposeBindings } : candidate);
        const current = await input.readViewerPurposeContext?.(context.signal, context);
        context.signal?.throwIfAborted();
        if (!descriptor || current?.profile.id !== input.accountId) return unavailable;
        return resolveWidgetConnectedAccountOptionsV1({ descriptor, resources: descriptor.resourceDeclarations ?? [],
            profile: current.profile, path: fieldPath, now: Date.now() }) ?? unavailable;
    }, widgetInputs: createWidgetActionInputResolverV1({
        readGroupBindings,
        readDescriptor: async request => {
            if (!input.accountId || await admitWidgetActionSurfaceV1(input.getDeps(), request.ref.surface, { ...request.context, signal: request.signal })) return null;
            if (request.instance.definition.kind === 'builtin') {
                const descriptor = readBuiltinWidgetDescriptorV1(request.instance.definition);
                if (descriptor && readWidgetInputTargetV1(descriptor).kind !== 'invalid') descriptors.set(request, descriptor);
                return descriptor;
            }
            const reference = request.instance.definition;
            if (reference.kind === 'artifact' && request.ref.surface.accountId !== input.accountId) return null;
            const authored = reference.kind === 'artifact' ? await input.getDeps().widgetDefinitionArtifacts?.get(reference.artifactId, request.signal)
                : reference.kind === 'inline' ? reference.definition : null;
            if ((reference.kind === 'artifact' || reference.kind === 'inline') && !authored) return null;
            if (authored?.body.kind === 'declarative') {
                const projection = await input.readResources?.(request.signal);
                let descriptor: Descriptor = { sizeDeclaration: authored.sizeDeclaration, inputs: authored.inputs, inputSchema: authored.inputSchema, sessionInputPath: authored.sessionInputPath,
                    connectedAccountPurposeBindings: authored.connectedAccountPurposeBindings, resources: readWidgetDefinitionResourcesV1(authored),
                    resourceDeclarations: projection?.resources ?? [], connectedAccountDescriptors: projection?.connectedAccountDescriptors ?? [] };
                const targetDeclaration = readWidgetInputTargetV1(descriptor);
                if (targetDeclaration.kind === 'invalid') return null;
                if (targetDeclaration.kind === 'session') {
                    const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor, providedContext: await readProvidedContext(request),
                        viewerValues: (await readViewerPurpose(request, descriptor))?.values ?? {} });
                    const session = bound.status === 'ready' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, targetDeclaration.path)) : null;
                    if (session?.success && session.data.serverId === input.serverId && await input.validateSession(session.data, request.signal)) {
                        const target = await input.readResources?.(request.signal, session.data);
                        descriptor = { ...descriptor, resourceDeclarations: target?.resources ?? [], connectedAccountDescriptors: target?.connectedAccountDescriptors ?? [] };
                    } else if (bound.status === 'ready') return null;
                }
                descriptors.set(request, descriptor);
                return descriptor;
            }
            const definition = authored?.body ?? reference;
            const matches = (candidate: Candidate) => candidate.availability === 'available'
                && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition);
            const owner = request.ref.surface.owner;
            const ownerSession = owner.kind === 'sessionBoard' || owner.kind === 'companion'
                ? { serverId: request.ref.surface.serverId, sessionId: owner.sessionId } : undefined;
            let candidate = (await input.readCandidates(request.signal, ownerSession)).find(matches);
            // A saved definition supplies its exact target field even when physical A
            // has no matching plugin. Bare installed copies discover metadata through
            // a unique current binding value, retaining exact Session access checks.
            if (!candidate && !authored) {
                const providedContext = await readProvidedContext(request);
                const discovered: Candidate[] = [];
                for (const [path, binding] of Object.entries(request.instance.bindings)) {
                    const values = binding.kind === 'value' ? [binding.value]
                        : binding.kind === 'context' ? providedContext[binding.slot] ?? [] : [];
                    if (values.length !== 1) continue;
                    const target = VoiceTrackedSessionAddressV1Schema.safeParse(values[0]);
                    if (!target.success || target.data.serverId !== input.serverId || !await input.validateSession(target.data, request.signal)) continue;
                    const current = (await input.readCandidates(request.signal, target.data)).filter(candidate => {
                        const declaration = readWidgetInputTargetV1(candidate);
                        return matches(candidate) && declaration.kind === 'session' && declaration.path === path;
                    });
                    discovered.push(...current);
                }
                if (discovered.length !== 1) return null;
                candidate = discovered[0];
            }
            const targetDescriptor = authored && readWidgetInputTargetV1(authored).kind !== 'app' ? authored : candidate;
            const targetDeclaration = targetDescriptor ? readWidgetInputTargetV1(targetDescriptor) : null;
            if (targetDeclaration?.kind === 'invalid') return null;
            if (targetDescriptor && targetDeclaration?.kind === 'session') {
                const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor: targetDescriptor,
                    providedContext: await readProvidedContext(request), viewerValues: (await readViewerPurpose(request, targetDescriptor))?.values ?? {} });
                const target = bound.status === 'ready' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, targetDeclaration.path)) : null;
                if (target?.success && target.data.serverId === input.serverId && await input.validateSession(target.data, request.signal)) {
                    const current = (await input.readCandidates(request.signal, target.data)).find(matches);
                    candidate = current && sameStrictJsonValue(readWidgetInputTargetV1(current), targetDeclaration) ? current : undefined;
                } else return null;
            }
            if (!candidate || authored && !sameStrictJsonValue(readWidgetInputTargetV1(candidate), readWidgetInputTargetV1(authored))) return null;
            const descriptor = authored ? { ...candidate, sizeDeclaration: authored.sizeDeclaration, inputs: authored.inputs, inputSchema: authored.inputSchema,
                sessionInputPath: authored.sessionInputPath, connectedAccountPurposeBindings: authored.connectedAccountPurposeBindings } : candidate;
            descriptors.set(request, descriptor);
            return descriptor;
        },
        readContext: async request => readContext(request),
        readViewerValues: async request => (await readViewerPurpose(request)) ?? { values: {} },
        readInputType: async (field, request) => field.inputType && !('hostType' in field.inputType)
            ? await input.getDeps().resolveInputType?.(field.inputType, { ...request.context,
                ...(request.signal ? { signal: request.signal } : {}) }) ?? null : null,
        validateValue: async (field, value, request) => {
            const binding = request.instance.bindings[field.path];
            if (binding?.kind === 'viewer') {
                const supplied = QualifiedConnectedAccountRefSchema.safeParse(value);
                const current = await readViewerPurpose(request);
                const own = current?.values[field.path];
                if (!supplied.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                if (!current || !own) return { status: 'unavailable', reasonCode: current?.fields.find(issue => issue.path === field.path)?.reasonCode ?? 'widget_viewer_connection_missing' };
                return isWidgetConnectedAccountSelectionEligibleV1({ field, binding, surface: request.ref.surface,
                    selection: supplied.data, viewerValues: current.values, profile: null, now: Date.now() })
                    ? { status: 'valid' } : { status: 'denied', reasonCode: 'widgets_viewer_selection_unavailable' };
            }
            if (field.connectedAccountOptions) {
                const supplied = QualifiedConnectedAccountRefSchema.safeParse(value);
                if (!supplied.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                const current = await input.readViewerPurposeContext?.(request.signal, request.context);
                if (!current || current.profile.id !== input.accountId || !isWidgetConnectedAccountSelectionEligibleV1({ field, binding,
                    surface: request.ref.surface, selection: supplied.data, viewerValues: {}, profile: current.profile, now: Date.now() }))
                    return { status: 'denied', reasonCode: 'widgets_viewer_selection_unavailable' };
                return { status: 'valid' };
            }
            const descriptor = descriptors.get(request);
            const target = descriptor ? readWidgetInputTargetV1(descriptor) : null;
            if (target?.kind === 'invalid') return { status: 'unavailable', reasonCode: target.reasonCode };
            if (target?.kind === 'workspace' && target.path === field.path) {
                return validateWidgetWorkspaceInputV1({ value, serverId: input.serverId,
                    contextValues: readContext(request)[target.path] ?? [] });
            }
            if (target?.kind !== 'session' || target.path !== field.path) return { status: 'valid' };
            const session = VoiceTrackedSessionAddressV1Schema.safeParse(value);
            if (!session.success) return { status: 'invalid', reasonCode: 'widget_session_selection_invalid' };
            if (session.data.serverId !== input.serverId) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
            return await input.validateSession(session.data, request.signal)
                ? { status: 'valid' } : { status: 'denied', reasonCode: 'widget_session_access_denied' };
        },
        resolveOptions: async (field, value, request) => {
            const descriptor = descriptors.get(request);
            const target = descriptor ? readWidgetInputTargetV1(descriptor) : null;
            const selected = target?.kind === 'session' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(value, target.path)) : null;
            const result = await createActionExecutor(input.getDeps()).execute('action.options.resolve', {
                consumer: { kind: 'widget', surface: request.ref.surface, definition: request.instance.definition,
                    ...(selected?.success ? { selectedSession: selected.data } : {}) },
                fieldPath: field.path, draftInput: value,
            }, { ...request.context, ...(request.signal ? { signal: request.signal } : {}) });
            if (!result.ok) return { status: result.errorCode === 'credential_scope_denied' ? 'denied' : 'unavailable', reasonCode: result.errorCode ?? 'widget_input_options_unavailable' };
            return (getActionSpec('action.options.resolve').outputSchema!.parse(result.result) as PublicActionResultById['action.options.resolve']).options;
        },
    }) };
}
