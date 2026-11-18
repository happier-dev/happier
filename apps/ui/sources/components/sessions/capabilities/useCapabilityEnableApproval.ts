import { buildExistingSessionCapabilitiesActionInput } from '@happier-dev/protocol/sessions/authoring/existingSessionActionInputs';
import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SessionCapabilitiesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { ReachDecisionV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useReachRulesCatalog } from '@/sync/store/useReachRulesCatalog';
import { createRequestOwnedActionExecution } from '@/components/approvals/requestOwnedActionExecution';
import { createRequestOwnedControllerStore } from '@/components/approvals/requestOwnedControllerStore';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useApprovalDecisionHandler, useApprovalHome } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';
import type { ReachRuleWriteV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { createReachRulesController, type ReachRulesSource } from '@/sync/domains/capabilities/reach/useReachRulesState';
import { createCapabilityEnableApprovalController, readCapabilityEnableApproval, resolveCapabilityAlwaysWrite, type CapabilityEnableApprovalSnapshot } from './capabilityEnableApproval';

type CapabilityEnableApprovalController = ReturnType<typeof createCapabilityEnableApprovalController>;
type SharedLatest = Readonly<{ alwaysWrite: ReachRuleWriteV1 | null; key: string;
    decide(decision: 'approve' | 'reject'): Promise<boolean> }>;
type SharedController = Readonly<{ controller: CapabilityEnableApprovalController;
    rules: ReturnType<typeof createReachRulesController> }>;
type MountedView = React.RefObject<{ current: SharedLatest; source: ReachRulesSource; scope: ServerAccountScope | null }>;
type Receipt = Readonly<{ snapshot: CapabilityEnableApprovalSnapshot; previousRules: ReturnType<SharedController['rules']['getUndoRules']> }>;
const idle: CapabilityEnableApprovalSnapshot = { status: 'idle', approved: false, errorCode: null, alwaysWrite: null };
/**
 * One decision per approval: the attention tray and the transcript row both draw this request, and the tray's
 * copy leaves as soon as the approval settles. Both share the controller, so the settled line, a pending
 * Always write and its failure stay visible where the request remains. Full controllers leave with their last
 * view/operation; later views restore only the acknowledged save/retry snapshot and rules inverse.
 */
const sharedControllers = createRequestOwnedControllerStore<SharedController, MountedView, Receipt>({
    create(readView, receipt) {
        const { current, source, scope } = readView()!.current;
        const key = current.key;
        const rules = createReachRulesController(source, createRequestOwnedActionExecution(scope), undefined, receipt?.previousRules);
        const controller = createCapabilityEnableApprovalController({
            get alwaysWrite() {
                const view = readView()?.current.current;
                return view?.key === key ? view.alwaysWrite : null;
            },
            decide: decision => {
                const view = readView()?.current.current;
                return view?.key === key ? view.decide(decision) : Promise.resolve(false);
            },
            changeRules: rules.change,
            undoRules: rules.undoLast,
        }, receipt?.snapshot);
        return { controller, rules };
    },
    subscribe: (shared, listener) => shared.controller.subscribe(listener),
    checkpoint(shared) {
        const snapshot = shared.controller.getSnapshot();
        return snapshot.status === 'always_saved' || snapshot.status === 'always_failed'
            ? { snapshot, previousRules: snapshot.status === 'always_saved' ? shared.rules.getUndoRules() : null } : null;
    },
});

/** Per-Action body logic. The existing approval owner decides/replays; the present user writes Always. */
export function useCapabilityEnableApproval(input: Readonly<{
    artifact: Pick<DecryptedArtifact, 'id' | 'header'>; approval: ApprovalRequest; sessionId: string;
    decidedBy: ReachDecisionV1['decidedBy']; projectKey: string | null; machineId: string | null;
    itemTitle: string; agentName: string; names: WhereItsOnNames;
}>) {
    const request = readCapabilityEnableApproval(input.approval);
    const home = useApprovalHome(input.artifact, input.approval, input.sessionId);
    const decideApproval = useApprovalDecisionHandler(input.artifact, input.approval, input.sessionId);
    const decide = React.useCallback(async (decision: 'approve' | 'reject') => {
        let enabled = false;
        const recorded = await decideApproval(decision, { onExecution: receipt => {
            const result = receipt?.ok ? SessionCapabilitiesSetOutputV1Schema.safeParse(receipt.result) : null;
            enabled = result?.success === true && result.data.ok;
        } });
        return recorded && (decision === 'reject' || enabled);
    }, [decideApproval]);
    const execution = useMountedActionExecution(home.serverId);
    const scope = request && execution.ready ? execution.binding?.scope ?? null : null;
    const kind = request?.kind === 'skill' ? 'skill' : 'mcp_server';
    const reach = useReachRulesCatalog(kind, request?.id ?? '', scope);
    const alwaysWrite = request && reach.status === 'ready' ? resolveCapabilityAlwaysWrite({ decidedBy: input.decidedBy, rules: reach.rules,
        projectKey: input.projectKey, machineId: input.machineId }) : null;
    // One decision per request and Account: every view of it (tray, transcript, Details) shares this controller.
    // View data may refresh; the request's acknowledged write and Undo remain owned by this entry.
    const key = JSON.stringify([input.artifact.id, scope?.serverId, scope?.accountId]);
    const source: ReachRulesSource = { key, kind, itemId: request?.id ?? '', rules: reach.acknowledgedRules,
        revision: reach.revision, status: reach.status, valueAvailable: reach.valueAvailable };
    const current: SharedLatest = { alwaysWrite, key, decide };
    const latest = React.useRef({ current, source, scope }); latest.current = { current, source, scope };
    React.useLayoutEffect(() => { sharedControllers.get(key)?.rules.updateSource(source); });
    const hasRequest = request !== null;
    const subscribe = React.useCallback((listener: () => void) => hasRequest ? sharedControllers.subscribe(key, latest, listener) : () => {}, [hasRequest, key]);
    const read = React.useCallback(() => hasRequest
        ? sharedControllers.get(key)?.controller.getSnapshot() ?? sharedControllers.getReceipt(key)?.snapshot ?? idle : null, [hasRequest, key]);
    const state = React.useSyncExternalStore(subscribe, read, read);
    const chosenWrite = state?.alwaysWrite ?? alwaysWrite;
    const place = chosenWrite?.place;
    const placeName = place?.t === 'project' ? input.names.projectName(place.projectKey)
        : place?.t === 'machine' ? input.names.machineName(place.machineId)
        : place?.t === 'workspace' ? input.names.folderLabel(place.machineId, place.workspaceRoot) : null;
    const alwaysLabel = placeName && chosenWrite ? chosenWrite.agentId
        ? t('capabilities.session.alwaysFor', { agent: input.names.agentName(chosenWrite.agentId), place: placeName })
        : t('capabilities.session.always', { place: placeName }) : null;
    const undoSession = React.useCallback(async () => {
        const current = input.approval.execution;
        const parsed = current?.ok ? SessionCapabilitiesSetOutputV1Schema.safeParse(current.result) : null;
        if (!request || !parsed?.success || !parsed.data.ok) return { ok: false as const, error: 'nothing_to_undo' };
        return execution.execute('session.capabilities.set', buildExistingSessionCapabilitiesActionInput({ sessionId: request.sessionId, kind: request.kind, id: request.id, state: parsed.data.previous }));
    }, [input.approval.execution, request, execution.execute]);
    const choose = React.useCallback((choice: 'session' | 'always' | 'reject') =>
        sharedControllers.run(key, shared => shared.controller.choose(choice)) ?? Promise.resolve(), [key]);
    const undoAlways = React.useCallback(() => sharedControllers.run(key, shared => shared.controller.undoAlways())
        ?? Promise.resolve({ ok: false as const, message: 'nothing_to_undo' }), [key]);
    return { request, state, ready: execution.ready, resolution: execution.resolution, rulesStatus: reach.status,
        serverId: home.serverId, alwaysWrite: chosenWrite, alwaysLabel,
        title: request ? t('capabilities.session.wants', { agent: input.agentName, item: input.itemTitle }) : null,
        reason: request?.reason ?? null, choose: hasRequest ? choose : undefined, retryAlways: hasRequest ? () => choose('always') : undefined,
        undoAlways: hasRequest ? undoAlways : undefined, undoSession };
}
