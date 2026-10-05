import type { ActionExecuteFailure, ActionExecutorDeps } from '@happier-dev/protocol';
import { readWidgetActionSurfacePortV1, widgetCandidateDefinitionV1, isSameWidgetDefinitionV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { selectWidgetCandidates, selectBuiltinWidgetCandidates, describeWidgetDefinitionSummaryV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { createSessionPluginPolicyEvaluationContext } from '@/components/sessions/model/usePluginUiSessionPolicyEvaluationContext';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { EMPTY_PLUGIN_UI_PROJECTION, resolvePluginUiProjectionState, resolvePluginUiProjectionPlatform, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { sync } from '@/sync/sync';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import type { ConnectedAccountUiProjectionEntryV1 } from '@happier-dev/protocol';
import type { LazyActionAccountContext } from './actionAccountContext';

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

export async function readWidgetActionRuntimeV1(
    surface: WidgetSurfaceRefV1, account: LazyActionAccountContext, signal?: AbortSignal,
    sessionTarget?: Readonly<{ serverId: string; sessionId: string }>,
): Promise<WidgetActionRuntimeV1 | ActionExecuteFailure> {
    account.assertCurrent();
    signal?.throwIfAborted();
    if (surface.serverId !== account.serverId || surface.accountId !== account.accountId) return unavailable('widget_scope_mismatch');
    const owner = surface.owner;
    const selectedSession = sessionTarget ?? (owner.kind === 'sessionBoard' || owner.kind === 'companion' ? { serverId: surface.serverId, sessionId: owner.sessionId } : undefined);
    const accountIsCurrent = () => account.accountLifetime?.isCurrent() === true
        && areServerAccountScopesEqual(getActiveServerAccountScope(), { serverId: account.serverId, accountId: account.accountId });
    if (!selectedSession) {
        if (!areServerAccountScopesEqual(getActiveServerAccountScope(), { serverId: account.serverId, accountId: account.accountId })) return unavailable('widget_catalog_unavailable');
        const projection = readCurrentAppShellPluginUiProjection();
        return { candidates: selectWidgetCandidates(projection), projection, machineId: null,
            isCurrent: () => accountIsCurrent() && readCurrentAppShellPluginUiProjection() === projection };
    }
    if (selectedSession.serverId !== account.serverId) return unavailable('widget_scope_mismatch');
    const outcome = await sync.withSessionSystemRecordRuntime(selectedSession, async runtime => {
        if (runtime.scope.accountId !== account.accountId || runtime.scope.serverId !== account.serverId) return unavailable('widget_scope_mismatch');
        if (!runtime.session.access?.capabilities.readTranscript) return unavailable('widget_read_denied');
        const target = readMachineControlTargetForSession({ ...selectedSession, accountId: runtime.scope.accountId });
        if (!target) return { candidates: selectBuiltinWidgetCandidates(), projection: null, machineId: null, isCurrent: accountIsCurrent };
        const projection = (await loadDaemonMergedProjectionInputs({ machineId: target.machineId, serverId: surface.serverId, accountLifetime: account.accountLifetime }))?.pluginProjectionV2;
        account.assertCurrent();
        signal?.throwIfAborted();
        const currentTarget = readMachineControlTargetForSession({ ...selectedSession, accountId: runtime.scope.accountId });
        if (!runtime.isCurrent()) return unavailable('widget_target_unavailable');
        if (currentTarget?.machineId !== target.machineId || !projection) return { candidates: selectBuiltinWidgetCandidates(), projection: null, machineId: null, isCurrent: accountIsCurrent };
        const model = resolvePluginUiProjectionState(EMPTY_PLUGIN_UI_PROJECTION, projection);
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
        const connectedAccounts = readConnectedAccountDescriptorProjection(projection);
        const connectedAccountDescriptors = connectedAccounts.kind === 'ready' ? connectedAccounts.descriptors : [];
        return { candidates: selectWidgetCandidates(model, policy).map(candidate => ({ ...candidate, connectedAccountDescriptors })),
            projection: model, machineId: target.machineId, connectedAccountDescriptors,
            isCurrent: () => {
                // The exact-Session request lease ends with this callback. Read
                // current canonical Account/Session facts, never retain its authority.
                const session = storage.getState().sessions[selectedSession.sessionId];
                return accountIsCurrent() && session?.access?.capabilities.readTranscript === true
                    && areServerProfileIdentifiersEquivalent(session.serverId, selectedSession.serverId)
                    && readMachineControlTargetForSession({ ...selectedSession, accountId: account.accountId })?.machineId === target.machineId;
            } };
    });
    return outcome.status === 'ok' ? outcome.value : unavailable('widget_scope_unavailable');
}

export async function readWidgetActionCandidatesV1(
    surface: WidgetSurfaceRefV1, account: LazyActionAccountContext, signal?: AbortSignal,
    sessionTarget?: Readonly<{ serverId: string; sessionId: string }>,
): Promise<readonly WidgetCandidate[] | ActionExecuteFailure> {
    const runtime = await readWidgetActionRuntimeV1(surface, account, signal, sessionTarget);
    return 'ok' in runtime ? runtime : runtime.candidates;
}

export function createWidgetCatalogActionDepsV1(account: LazyActionAccountContext | null | undefined, deps: ActionExecutorDeps): Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetCatalog'> {
    if (!account) return {};
    return {
        widgetAccountScope: () => { account.assertCurrent(); return { serverId: account.serverId, accountId: account.accountId }; },
        widgetCatalog: { list: async (surface, context, signal, boundSession) => {
            const candidates = await readWidgetActionCandidatesV1(surface, account, signal, boundSession);
            if ('ok' in candidates) return candidates;
            const port = readWidgetSurfaceActionPortV1(deps, surface);
            if (!port) return unavailable('unsupported_widget_surface');
            const read = await port.read(surface, context, signal);
            if ('ok' in read) return read;
            const definitions = deps.widgetDefinitionArtifacts ? await deps.widgetDefinitionArtifacts.list(signal) : [];
            const authored = definitions.map(summary => describeWidgetDefinitionSummaryV1(summary,
                summary.sourceDefinition ? candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), summary.sourceDefinition!)) : null));
            account.assertCurrent();
            return [...candidates, ...authored].map(candidate => ({ definition: widgetCandidateDefinitionV1(candidate), title: candidate.title,
                fields: [...candidate.inputs?.fields ?? []], availability: candidate.sourceDefinition
                    && !candidates.some(current => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(current), candidate.sourceDefinition!))
                    ? 'unavailable' as const : 'available' as const,
                instanceCount: read.instances.filter(entry => isSameWidgetDefinitionV1(entry.instance.definition, widgetCandidateDefinitionV1(candidate))).length }));
        } },
    };
}
