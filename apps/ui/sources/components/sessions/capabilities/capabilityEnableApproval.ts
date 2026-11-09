import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SessionCapabilitiesSetInputV1Schema, type SessionCapabilitiesSetInputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { ReachDecisionV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { ReachRuleWriteV1, ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ReachRulesWriteResult } from '@/sync/domains/capabilities/reach/useReachRulesState';

export type CapabilityEnableApproval = SessionCapabilitiesSetInputV1 & Readonly<{ agentId: string | null }>;
export function readCapabilityEnableApproval(approval: ApprovalRequest): CapabilityEnableApproval | null {
    if (approval.actionId !== 'session.capabilities.set'
        || !['agent', 'session_agent', 'mcp'].includes(approval.createdBy.surface)) return null;
    const parsed = SessionCapabilitiesSetInputV1Schema.safeParse(approval.actionArgs);
    return parsed.success && parsed.data.state === 'on' && parsed.data.kind !== 'native_skill'
        ? { ...parsed.data, agentId: approval.createdBy.agentId ?? null } : null;
}

/** Preserve the deciding rule's Agent scope. An Everywhere refusal widens only to this Project/Machine. */
export function resolveCapabilityAlwaysWrite(input: Readonly<{
    decidedBy: ReachDecisionV1['decidedBy']; rules: ReachRulesV1; projectKey: string | null; machineId: string | null;
}>): ReachRuleWriteV1 | null {
    const rule = input.decidedBy ? input.rules.find(rule => rule.id === input.decidedBy!.ruleId) : null;
    if (input.decidedBy && (!rule || rule.target.t !== input.decidedBy.target
        || (rule.agentId !== undefined) !== input.decidedBy.agentQualified)) return null;
    const place = rule && rule.target.t !== 'allMachines' ? rule.target
        : input.projectKey ? { t: 'project' as const, projectKey: input.projectKey }
        : input.machineId ? { t: 'machine' as const, machineId: input.machineId } : null;
    return place ? { place, ...(rule?.agentId !== undefined ? { agentId: rule.agentId } : {}), state: 'on' } : null;
}

export type CapabilityEnableApprovalSnapshot = Readonly<{
    status: 'idle' | 'deciding' | 'session_allowed' | 'rejected' | 'saving_always' | 'always_saved' | 'decision_failed' | 'always_failed';
    approved: boolean; errorCode: string | null;
    alwaysWrite: ReachRuleWriteV1 | null;
}>;
export type CapabilityEnableApprovalInput = Readonly<{
    alwaysWrite: ReachRuleWriteV1 | null;
    decide(decision: 'approve' | 'reject'): Promise<boolean>;
    changeRules(change: ReachRulesChangeV1): Promise<ReachRulesWriteResult>;
    undoRules(): Promise<ReachRulesWriteResult>;
}>;
export function createCapabilityEnableApprovalController(input: CapabilityEnableApprovalInput, receipt?: CapabilityEnableApprovalSnapshot) {
    let snapshot: CapabilityEnableApprovalSnapshot = receipt ?? { status: 'idle', approved: false, errorCode: null, alwaysWrite: null };
    let inFlight: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    const publish = (patch: Partial<CapabilityEnableApprovalSnapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
    const choose = (choice: 'session' | 'always' | 'reject'): Promise<void> => {
        if (inFlight) return inFlight;
        if (snapshot.status === 'rejected' || snapshot.status === 'always_saved' || choice === 'session' && snapshot.approved) return Promise.resolve();
        const write = snapshot.alwaysWrite ?? input.alwaysWrite;
        if (choice === 'always' && !write || choice === 'reject' && snapshot.approved) return Promise.resolve();
        if (choice === 'always') publish({ alwaysWrite: write });
        inFlight = (async () => {
            if (!snapshot.approved) {
                publish({ status: 'deciding', errorCode: null });
                try {
                    if (!await input.decide(choice === 'reject' ? 'reject' : 'approve')) { publish({ status: 'decision_failed', errorCode: 'approval_decision_failed' }); return; }
                } catch { publish({ status: 'decision_failed', errorCode: 'approval_decision_failed' }); return; }
                if (choice === 'reject') { publish({ status: 'rejected' }); return; }
                publish({ status: 'session_allowed', approved: true });
            }
            if (choice !== 'always') return;
            publish({ status: 'saving_always', errorCode: null });
            try {
                if (!write) return;
                const receipt = await input.changeRules({ kind: 'write', write });
                if (!receipt.ok) { publish({ status: 'always_failed', errorCode: receipt.message }); return; }
                publish({ status: 'always_saved' });
            } catch { publish({ status: 'always_failed', errorCode: 'rules_write_failed' }); }
        })().finally(() => { inFlight = null; });
        return inFlight;
    };
    const undoAlways = async (): Promise<ReachRulesWriteResult> => {
        if (snapshot.status !== 'always_saved') return { ok: false, message: 'nothing_to_undo' };
        const result = await input.undoRules();
        if (result.ok) publish({ status: 'session_allowed', alwaysWrite: null, errorCode: null });
        else publish({ errorCode: result.message });
        return result;
    };
    return { choose, undoAlways, getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
