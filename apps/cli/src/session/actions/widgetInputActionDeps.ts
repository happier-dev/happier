import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { isQualifiedConnectedAccountProfileActiveV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { ActionExecutorDeps, AccountProfile, ConnectedAccountUiProjectionEntryV1, PluginContributionIdentityV1, PluginProjectedResourceV2, QualifiedConnectedAccountPurposeBindingsV1, JsonValue, PublicActionResultById } from '@happier-dev/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { readBuiltinWidgetDescriptorV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { readWidgetDefinitionResourcesV1 } from '@happier-dev/protocol/widgets/widgetDefinitionV1';
import { createWidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets/widgetActionInputResolverV1';
import { resolveConfiguredWidgetTargetInputV1 } from '@happier-dev/protocol/widgets/widgetInputAdmissionV1';
import { resolveWidgetViewerPurposeValuesV1, resolveWidgetConnectedAccountOptionsV1 } from '@happier-dev/protocol/widgets/widgetViewerPurposeV1';
import type { WidgetCandidateIdentityV1, WidgetActionInputResolverV1, WidgetInputDescriptorV1 } from '@happier-dev/protocol/widgets';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';

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
    readViewerPurposeContext?(signal?: AbortSignal): Promise<Readonly<{ profile: AccountProfile; purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 }> | null>;
    validateSession(session: Readonly<{ serverId: string; sessionId: string }>, signal?: AbortSignal): Promise<boolean>;
}>): Pick<ActionExecutorDeps, 'widgetInputs' | 'widgetConnectedAccountOptions'> {
    const descriptors = new WeakMap<Request, Descriptor>();
    const readViewerPurpose = async (request: Request, descriptor = descriptors.get(request)) => {
        if (!descriptor || !input.accountId || request.ref.surface.serverId !== input.serverId || request.ref.surface.accountId !== input.accountId) return null;
        const current = await input.readViewerPurposeContext?.(request.signal);
        request.signal?.throwIfAborted();
        if (!current || current.profile.id !== input.accountId) return null;
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
    return { widgetConnectedAccountOptions: async ({ consumer, fieldPath, context }) => {
        const unavailable = { ok: false as const, errorCode: 'widget_connected_account_options_unavailable', error: 'widget_connected_account_options_unavailable' };
        if (!input.accountId || consumer.surface.serverId !== input.serverId || consumer.surface.accountId !== input.accountId) return unavailable;
        if (consumer.surface.owner.kind === 'sessionBoard') return { ok: false, errorCode: 'widgets_viewer_selection_unavailable', error: 'widgets_viewer_selection_unavailable' };
        const reference = consumer.definition;
        const authored = reference.kind === 'inline' ? reference.definition
            : reference.kind === 'artifact' ? await input.getDeps().widgetDefinitionArtifacts?.get(reference.artifactId, context.signal) : null;
        if ((reference.kind === 'inline' || reference.kind === 'artifact') && !authored) return unavailable;
        const definition = authored?.body.kind === 'installed' ? authored.body : reference;
        const candidate = (await input.readCandidates(context.signal, consumer.selectedSession)).find(candidate => candidate.availability === 'available'
            && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition));
        const resources = authored?.body.kind === 'declarative' ? await input.readResources?.(context.signal, consumer.selectedSession) : null;
        const descriptor: Descriptor | undefined = authored?.body.kind === 'declarative'
            ? { ...authored, resources: readWidgetDefinitionResourcesV1(authored), resourceDeclarations: resources?.resources ?? [] }
            : candidate && (authored ? { ...candidate, inputs: authored.inputs, inputSchema: authored.inputSchema,
                connectedAccountPurposeBindings: authored.connectedAccountPurposeBindings } : candidate);
        const current = await input.readViewerPurposeContext?.(context.signal);
        context.signal?.throwIfAborted();
        if (!descriptor || current?.profile.id !== input.accountId) return unavailable;
        return resolveWidgetConnectedAccountOptionsV1({ descriptor, resources: descriptor.resourceDeclarations ?? [],
            profile: current.profile, path: fieldPath, now: Date.now() }) ?? unavailable;
    }, widgetInputs: createWidgetActionInputResolverV1({
        readDescriptor: async request => {
            if (!input.accountId || request.ref.surface.serverId !== input.serverId || request.ref.surface.accountId !== input.accountId) return null;
            if (request.instance.definition.kind === 'builtin') {
                const descriptor = readBuiltinWidgetDescriptorV1(request.instance.definition);
                if (descriptor) descriptors.set(request, descriptor);
                return descriptor;
            }
            const reference = request.instance.definition;
            const authored = reference.kind === 'artifact' ? await input.getDeps().widgetDefinitionArtifacts?.get(reference.artifactId, request.signal)
                : reference.kind === 'inline' ? reference.definition : null;
            if ((reference.kind === 'artifact' || reference.kind === 'inline') && !authored) return null;
            if (authored?.body.kind === 'declarative') {
                const projection = await input.readResources?.(request.signal);
                let descriptor: Descriptor = { inputs: authored.inputs, inputSchema: authored.inputSchema, sessionInputPath: authored.sessionInputPath,
                    connectedAccountPurposeBindings: authored.connectedAccountPurposeBindings, resources: readWidgetDefinitionResourcesV1(authored),
                    resourceDeclarations: projection?.resources ?? [], connectedAccountDescriptors: projection?.connectedAccountDescriptors ?? [] };
                if (descriptor.sessionInputPath) {
                    const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor, providedContext: readContext(request),
                        viewerValues: (await readViewerPurpose(request, descriptor))?.values ?? {} });
                    const session = bound.status === 'ready' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, descriptor.sessionInputPath)) : null;
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
            let candidate = (await input.readCandidates(request.signal)).find(matches);
            if (candidate?.sessionInputPath) {
                const bound = resolveConfiguredWidgetTargetInputV1({ instance: request.instance, descriptor: candidate,
                    providedContext: readContext(request), viewerValues: (await readViewerPurpose(request, candidate))?.values ?? {} });
                const target = bound.status === 'ready' ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(bound.input, candidate.sessionInputPath)) : null;
                if (target?.success && target.data.serverId === input.serverId) {
                    const current = (await input.readCandidates(request.signal, target.data)).find(matches);
                    candidate = current?.sessionInputPath === candidate.sessionInputPath ? current : undefined;
                }
            }
            if (!candidate || authored && candidate.sessionInputPath !== authored.sessionInputPath) return null;
            const descriptor = authored ? { ...candidate, inputs: authored.inputs, inputSchema: authored.inputSchema,
                sessionInputPath: authored.sessionInputPath, connectedAccountPurposeBindings: authored.connectedAccountPurposeBindings } : candidate;
            descriptors.set(request, descriptor);
            return descriptor;
        },
        readContext: async request => readContext(request),
        readViewerValues: async request => (await readViewerPurpose(request)) ?? { values: {} },
        readInputType: async (field, request) => field.inputType
            ? await input.getDeps().resolveInputType?.(field.inputType, { ...request.context,
                ...(request.signal ? { signal: request.signal } : {}) }) ?? null : null,
        validateValue: async (field, value, request) => {
            if (request.instance.bindings[field.path]?.kind === 'viewer') {
                const supplied = QualifiedConnectedAccountRefSchema.safeParse(value);
                const current = await readViewerPurpose(request);
                const own = current?.values[field.path];
                if (!supplied.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                if (!own) return { status: 'unavailable', reasonCode: current?.fields.find(issue => issue.path === field.path)?.reasonCode ?? 'widget_viewer_connection_missing' };
                return sameQualifiedConnectedAccountRef(own, supplied.data)
                    ? { status: 'valid' } : { status: 'denied', reasonCode: 'widgets_viewer_selection_unavailable' };
            }
            if (field.connectedAccountOptions) {
                const supplied = QualifiedConnectedAccountRefSchema.safeParse(value);
                if (!supplied.success) return { status: 'invalid', reasonCode: 'widgets_viewer_selection_invalid' };
                const current = await input.readViewerPurposeContext?.(request.signal);
                if (request.ref.surface.owner.kind === 'sessionBoard' || !current || current.profile.id !== input.accountId
                    || !current.profile.connectedAccountsV4.some(account => sameQualifiedConnectedAccountRef(account.ref, supplied.data)
                        && isQualifiedConnectedAccountProfileActiveV4(account, Date.now())))
                    return { status: 'denied', reasonCode: 'widgets_viewer_selection_unavailable' };
                return { status: 'valid' };
            }
            if (descriptors.get(request)?.sessionInputPath !== field.path) return { status: 'valid' };
            const session = VoiceTrackedSessionAddressV1Schema.safeParse(value);
            if (!session.success) return { status: 'invalid', reasonCode: 'widget_session_selection_invalid' };
            if (session.data.serverId !== input.serverId) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
            return await input.validateSession(session.data, request.signal)
                ? { status: 'valid' } : { status: 'denied', reasonCode: 'widget_session_access_denied' };
        },
        resolveOptions: async (field, value, request) => {
            const sessionPath = descriptors.get(request)?.sessionInputPath;
            const selected = sessionPath ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(value, sessionPath)) : null;
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
