import type { ActionExecuteFailure} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readWidgetActionSurfacePortV1, widgetCandidateDefinitionV1, isSameWidgetDefinitionV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { readWidgetActionSessionTargetV1 } from '@happier-dev/protocol/widgets/actionsV1';
import { describeWidgetAreaApprovalSurfaceV1 } from '@happier-dev/protocol/widgets';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { selectWidgetCandidates, selectBuiltinWidgetCandidates, readWidgetDescriptor, describeWidgetDefinitionSummaryV1, describeAuthoredWidgetDefinitionV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { createSessionPluginPolicyEvaluationContext } from '@/components/sessions/model/usePluginUiSessionPolicyEvaluationContext';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { resolvePluginUiProjectionPlatform, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { sync } from '@/sync/sync';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ConnectedAccountUiProjectionEntryV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { LazyActionAccountContext } from './actionAccountContext';
import { admitWidgetActionSurfaceV1, readWidgetActionAccountScopeAdmissionV1 } from '@happier-dev/protocol/widgets';
import { readProjectActionContext } from './projectActionContext';

const unavailable = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** The UI ports all delegate to the incumbent native surface owner. */
export function readWidgetSurfaceActionPortV1(deps: ActionExecutorDeps, surface: WidgetSurfaceRefV1) {
    return readWidgetActionSurfacePortV1(deps, surface);
}

/** Reads the same admitted catalog projection as Gallery; physical hosting supplies no execution authority. */
export type WidgetActionRuntimeV1 = Readonly<{
    candidates: readonly WidgetCandidate[];
    projection: PluginUiProjectionModel | null;
    machineId: string | null;
    connectedAccountDescriptors?: readonly ConnectedAccountUiProjectionEntryV1[];
    isCurrent(): boolean;
}>;

/** Installed App metadata belongs to the proven active UI Account, not an arbitrary captured Home. */
export function canReadActiveWidgetCatalogV1(account: Pick<LazyActionAccountContext, 'serverId' | 'accountId'>): boolean {
    return areServerAccountScopesEqual(getActiveServerAccountScope(), { serverId: account.serverId, accountId: account.accountId });
}

export async function readWidgetActionRuntimeV1(
    surface: WidgetSurfaceRefV1, account: LazyActionAccountContext, signal?: AbortSignal,
    sessionTarget?: Readonly<{ serverId: string; sessionId: string }>, deps?: ActionExecutorDeps,
): Promise<WidgetActionRuntimeV1 | ActionExecuteFailure> {
    account.assertCurrent();
    signal?.throwIfAborted();
    if (deps) {
        const refusal = await admitWidgetActionSurfaceV1(deps, surface, { surface: 'ui', ...(signal ? { signal } : {}) });
        if (refusal) return refusal;
    } else if (!areServerProfileIdentifiersEquivalent(surface.serverId, account.serverId) || surface.accountId !== account.accountId) return unavailable('widget_scope_mismatch');
    return readWidgetActionProjectionV1(surface, account, signal, sessionTarget);
}

/** One projection/context owner for execution candidates and retained declaration metadata. */
async function readWidgetActionProjectionV1(
    surface: WidgetSurfaceRefV1, account: LazyActionAccountContext, signal?: AbortSignal,
    sessionTarget?: Readonly<{ serverId: string; sessionId: string }>,
): Promise<(WidgetActionRuntimeV1 & Readonly<{ declarations: PluginUiProjectionModel | null }>) | ActionExecuteFailure> {
    const selectedSession = readWidgetActionSessionTargetV1(surface, sessionTarget);
    const physicalSession = readWidgetActionSessionTargetV1(surface);
    const accountIsCurrent = () => account.accountLifetime?.isCurrent() === true && canReadActiveWidgetCatalogV1(account);
    if (!selectedSession) {
        if (!canReadActiveWidgetCatalogV1(account)) return unavailable('widget_catalog_unavailable');
        const projection = readCurrentAppShellPluginUiProjection();
        const declarations = readCurrentAppShellPluginUiProjection({
            scope: { serverId: account.serverId, accountId: account.accountId }, declarationsOnly: true,
        });
        const hasProjectWidgets = surface.owner.kind === 'project' && Object.values(projection?.surfacePlacementsById ?? {}).some(placement =>
            placement.binding.kind === 'inline' && placement.binding.role === 'widget' && placement.binding.targetKind === 'project');
        const project = hasProjectWidgets && surface.owner.kind === 'project'
            ? await readProjectActionContext(account, { serverId: surface.serverId, projectKey: surface.owner.projectId }, { surface: 'ui', signal }) : null;
        if (project && !project.ok) return project;
        account.assertCurrent();
        signal?.throwIfAborted();
        return { candidates: selectWidgetCandidates(projection, project?.ok ? project.projectContext.policyContext : undefined), projection, declarations, machineId: null,
            isCurrent: () => accountIsCurrent() && readCurrentAppShellPluginUiProjection() === projection };
    }
    if (!areServerProfileIdentifiersEquivalent(selectedSession.serverId, account.serverId)) return unavailable('widget_scope_mismatch');
    if (physicalSession && physicalSession.sessionId !== selectedSession.sessionId) {
        const admission = await sync.withSessionSystemRecordRuntime(physicalSession, async runtime => {
            return runtime.scope.accountId === account.accountId && runtime.isCurrent()
                && runtime.session.access?.capabilities.readTranscript === true;
        });
        account.assertCurrent();
        signal?.throwIfAborted();
        if (admission.status !== 'ok' || !admission.value) return unavailable('widget_read_denied');
    }
    const outcome = await sync.withSessionSystemRecordRuntime(selectedSession, async runtime => {
        if (runtime.scope.accountId !== account.accountId || !areServerProfileIdentifiersEquivalent(runtime.scope.serverId, account.serverId)) return unavailable('widget_scope_mismatch');
        if (!runtime.session.access?.capabilities.readTranscript) return unavailable('widget_read_denied');
        const target = readMachineControlTargetForSession({ ...selectedSession, accountId: runtime.scope.accountId });
        if (!target) return { candidates: selectBuiltinWidgetCandidates(), projection: null, declarations: null, machineId: null, isCurrent: accountIsCurrent };
        // Widget candidates and their connected-account descriptors are presented plugin UI.
        const inputs = await loadDaemonMergedProjectionInputs({ machineId: target.machineId, serverId: surface.serverId, accountLifetime: account.accountLifetime,
            sections: PLUGIN_UI_SECTIONS });
        const projection = inputs?.pluginProjectionV2;
        account.assertCurrent();
        signal?.throwIfAborted();
        const currentTarget = readMachineControlTargetForSession({ ...selectedSession, accountId: runtime.scope.accountId });
        if (!runtime.isCurrent()) return unavailable('widget_target_unavailable');
        if (currentTarget?.machineId !== target.machineId || !projection) return { candidates: selectBuiltinWidgetCandidates(), projection: null, declarations: null, machineId: null, isCurrent: accountIsCurrent };
        const model = inputs!.pluginUiProjection;
        const [settings, serverFeaturesSnapshot] = await Promise.all([account.readSettings(), getServerFeaturesSnapshot({ serverId: surface.serverId })]);
        account.assertCurrent();
        signal?.throwIfAborted();
        if (!runtime.isCurrent()) return unavailable('widget_scope_unavailable');
        const policy = createSessionPluginPolicyEvaluationContext({
            platform: resolvePluginUiProjectionPlatform(), serverId: surface.serverId,
            settings, serverFeaturesSnapshot,
            facts: { pluginEnabled: true, sessionAgentId: readSessionPresentationAgentId(runtime.session),
                sessionState: getSessionStatus(runtime.session).state, machineId: target.machineId, projectId: null, browserExists: false },
        });
        const connectedAccounts = inputs!.connectedAccountProjection;
        const connectedAccountDescriptors = connectedAccounts?.kind === 'ready' ? connectedAccounts.descriptors : [];
        return { candidates: selectWidgetCandidates(model, policy).map(candidate => ({ ...candidate, connectedAccountDescriptors })),
            projection: model, declarations: model, machineId: target.machineId, connectedAccountDescriptors,
            isCurrent: () => {
                // The exact-Session request lease ends with this callback. Read
                // current canonical Account/Session facts, never retain its authority.
                const session = storage.getState().sessions[selectedSession.sessionId];
                const physical = physicalSession ? storage.getState().sessions[physicalSession.sessionId] : null;
                return accountIsCurrent() && session?.access?.capabilities.readTranscript === true
                    && (!physicalSession || physical?.access?.capabilities.readTranscript === true
                        && areServerProfileIdentifiersEquivalent(physical.serverId, physicalSession.serverId))
                    && areServerProfileIdentifiersEquivalent(session.serverId, selectedSession.serverId)
                    && readMachineControlTargetForSession({ ...selectedSession, accountId: account.accountId })?.machineId === target.machineId;
            } };
    });
    return outcome.status === 'ok' ? outcome.value : unavailable('widget_scope_unavailable');
}

export async function readWidgetActionCandidatesV1(
    surface: WidgetSurfaceRefV1, account: LazyActionAccountContext, signal?: AbortSignal,
    sessionTarget?: Readonly<{ serverId: string; sessionId: string }>, deps?: ActionExecutorDeps,
): Promise<readonly WidgetCandidate[] | ActionExecuteFailure> {
    const runtime = await readWidgetActionRuntimeV1(surface, account, signal, sessionTarget, deps);
    return 'ok' in runtime ? runtime : runtime.candidates;
}

export function createWidgetCatalogActionDepsV1(account: LazyActionAccountContext | null | undefined, deps: ActionExecutorDeps): Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetCatalog'> {
    if (!account) return {};
    const widgetAccountScope: NonNullable<ActionExecutorDeps['widgetAccountScope']> = () => {
        account.assertCurrent();
        return { serverId: account.serverId, accountId: account.accountId,
            isSameServerId: serverId => areServerProfileIdentifiersEquivalent(serverId, account.serverId) };
    };
    const catalogDeps = { ...deps, widgetAccountScope };
    return {
        widgetAccountScope,
        widgetCatalog: { describeSurface: async (surface, _context, signal) => {
            account.assertCurrent();
            signal?.throwIfAborted();
            if (!canReadActiveWidgetCatalogV1(account)) return null;
            const projection = readCurrentAppShellPluginUiProjection();
            return describeWidgetAreaApprovalSurfaceV1(surface, Object.values(projection?.surfacePlacementsById ?? {}));
        }, readInstalledDescriptor: async ({ surface, definition, context, signal, boundSession }) => {
            account.assertCurrent();
            signal?.throwIfAborted();
            const admission = readWidgetActionAccountScopeAdmissionV1(catalogDeps, surface, context);
            if (!admission.ok) return admission;
            const runtime = await readWidgetActionProjectionV1(surface, account, signal, boundSession);
            if ('ok' in runtime) return runtime;
            if (!runtime.isCurrent()) return unavailable('widget_scope_unavailable');
            const descriptor = readWidgetDescriptor(runtime.declarations, definition);
            return descriptor ? { ...descriptor, availability: runtime.candidates.some(candidate =>
                isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition)) ? 'available' : 'unavailable' } : null;
        }, list: async (surface, context, signal, boundSession) => {
            const port = readWidgetSurfaceActionPortV1(catalogDeps, surface);
            if (!port) return unavailable('unsupported_widget_surface');
            const read = await port.read(surface, context, signal);
            if ('ok' in read) return read;
            const candidates = await readWidgetActionCandidatesV1(surface, account, signal, boundSession, catalogDeps);
            if ('ok' in candidates) return candidates;
            const definitions = catalogDeps.widgetDefinitionArtifacts ? await catalogDeps.widgetDefinitionArtifacts.list(signal) : [];
            const authored = definitions.map(summary => describeWidgetDefinitionSummaryV1(summary,
                summary.sourceDefinition ? candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), summary.sourceDefinition!)) : null));
            // Inline metadata is discoverable only from this surface's admitted
            // records, never from the definition submitted by an options caller.
            const placed: WidgetCandidate[] = [];
            for (const { instance } of read.instances) {
                const reference = instance.definition;
                if (reference.kind !== 'inline' || placed.some(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), reference))) continue;
                const body = reference.definition.body;
                const installed = body.kind === 'installed'
                    ? candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), body)) : null;
                placed.push(describeAuthoredWidgetDefinitionV1(reference.definition, reference, installed));
            }
            account.assertCurrent();
            return [...candidates, ...authored, ...placed].map(candidate => ({ definition: widgetCandidateDefinitionV1(candidate), title: candidate.title,
                target: candidate.target,
                sizeDeclaration: candidate.sizeDeclaration,
                ...(candidate.publicPresentation ? { publicPresentation: candidate.publicPresentation } : {}),
                fields: [...candidate.inputs?.fields ?? []], ...(candidate.inputSchema ? { inputSchema: candidate.inputSchema } : {}), availability: candidate.sourceDefinition
                    && !candidates.some(current => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(current), candidate.sourceDefinition!))
                    ? 'unavailable' as const : 'available' as const,
                instanceCount: read.instances.filter(entry => isSameWidgetDefinitionV1(entry.instance.definition, widgetCandidateDefinitionV1(candidate))).length }));
        } },
    };
}
