import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { SessionCapabilitiesGetOutputV1, SessionCapabilitiesSetOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { t } from '@/text';
import { readAppliedSessionCapabilitySelectionFromMetadataV1, readSessionCapabilitySelectionFromMetadataV1, readPendingCapabilityApplyV1, readPendingCapabilityRuleApplyV1, readCapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { readSessionCapabilityOverrideV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { SessionSkillApplicationFacts } from '@/sync/domains/capabilities/session/useSessionCapabilities';

export type SessionCapabilityChange = Readonly<{ kind: 'skill' | 'mcp_server' | 'native_skill'; title: string; state: 'on' | 'off' | 'inherit' }>;
export type SessionCapabilityApplyChange = (SessionCapabilityChange | Readonly<{ kind: 'skill' | 'mcp_server'; source: 'rules' }>)
    & Readonly<Pick<PendingApply, 'reason' | 'restartBy'>>;
export type SessionCapabilityApplyNoticeKey = 'addedNow' | 'removedNow' | 'appliedNow' | 'joinsNextTurn' | 'leavesNextTurn' | 'pendingNextTurn'
    | 'newSessionsOnly' | 'offline' | 'restart' | 'restartTerminal' | 'cannotResume' | 'nextStart' | 'saved';
export type SessionCapabilityApplyNotice = Readonly<{ key: SessionCapabilityApplyNoticeKey; text: string; restart: 'enabled' | 'disabled' | null }>;
type PendingApply = Extract<SessionCapabilitiesGetOutputV1, { ok: true }>['pendingApply'];

/** All writers share the metadata codec, including rule changes without Session overrides. */
export function readSessionCapabilityApplyChange(metadata: unknown,
    titleFor: (kind: SessionCapabilityChange['kind'], id: string) => string | null): SessionCapabilityApplyChange | null {
    const apply = readCapabilitySelectionApplyV1(metadata);
    if (readPendingCapabilityRuleApplyV1(metadata, 'mcp')) return { kind: 'mcp_server', source: 'rules', ...apply.mcp };
    if (readPendingCapabilityRuleApplyV1(metadata, 'skills')) return { kind: 'skill', source: 'rules', ...apply.skills };
    const desired = readSessionCapabilitySelectionFromMetadataV1(metadata), applied = readAppliedSessionCapabilitySelectionFromMetadataV1(metadata);
    const pending = readPendingCapabilityApplyV1(metadata);
    const candidates: SessionCapabilityApplyChange[] = [];
    const kinds = [
        ['mcp_server', pending.mcp, [...desired.mcp.forceIncludeServerIds, ...desired.mcp.forceExcludeServerIds, ...applied.mcp.forceIncludeServerIds, ...applied.mcp.forceExcludeServerIds]],
        ['skill', pending.skills, [...desired.skills.forceIncludeSkillIds, ...desired.skills.forceExcludeSkillIds, ...applied.skills.forceIncludeSkillIds, ...applied.skills.forceExcludeSkillIds]],
        ['native_skill', pending.skills, [...desired.skills.excludeNativeSkillNames, ...applied.skills.excludeNativeSkillNames]],
    ] as const;
    for (const [kind, changed, ids] of kinds) {
        if (!changed) continue;
        for (const id of new Set(ids)) {
            const state = readSessionCapabilityOverrideV1(desired, kind, id);
            if (state === readSessionCapabilityOverrideV1(applied, kind, id)) continue;
            const title = titleFor(kind, id);
            if (!title) return null;
            candidates.push({ kind, title, state, ...apply[kind === 'mcp_server' ? 'mcp' : 'skills'] });
        }
    }
    return candidates.length === 1 ? candidates[0]! : null;
}

/** Pure presentation of P2's acknowledged/pending facts, shared by sheet, mention picks and approvals. */
export function sessionCapabilityApplyNotice(input: Readonly<{
    pendingApply: PendingApply;
    applyTiming: Readonly<{ mcp: CapabilityApplyTimingV1; skills: CapabilityApplyTimingV1 }> | null;
    change: SessionCapabilityApplyChange | null;
    machineOnline: boolean | null; machineName: string; turnSettled: boolean;
    translate?: (key: `capabilities.session.apply.${SessionCapabilityApplyNoticeKey}`, params: Readonly<{ item: string; machine: string }>) => string;
}>): SessionCapabilityApplyNotice | null {
    const pending = input.pendingApply.mcp || input.pendingApply.skills;
    const changeKind = input.change?.kind === 'mcp_server' ? 'mcp' : 'skills';
    const currentChange = pending && !input.pendingApply[changeKind] ? null : input.change;
    const rulesChanged = currentChange !== null && 'source' in currentChange;
    const change = currentChange && !('source' in currentChange) ? currentChange : null;
    const kind = currentChange?.kind === 'mcp_server' ? 'mcp' : currentChange ? 'skills' : input.pendingApply.mcp ? 'mcp' : 'skills';
    // A runner record describes this change; the Agent declaration only previews
    // what can happen before the runner has observed/applied it. Keep each kind's
    // record paired with its change when several kinds are pending together.
    // The aggregate reason describes MCP when both kinds are pending. A local
    // skill receipt must use its own runtime record or its declared timing.
    const aggregateKind = input.pendingApply.mcp ? 'mcp' : 'skills';
    const record = currentChange?.reason !== undefined ? currentChange
        : input.pendingApply.reason !== undefined && kind === aggregateKind ? input.pendingApply : null;
    const timing = record ? { t: record.reason, restartBy: record.restartBy } : input.applyTiming?.[kind];
    if (!pending && !(change && timing?.t === 'applied_now')) return null;
    let key: SessionCapabilityApplyNoticeKey;
    let restart: SessionCapabilityApplyNotice['restart'] = null;
    if (timing?.t === 'missing_resume_snapshot' || timing?.t === 'missing_resume_identity') key = 'cannotResume';
    else if (record?.reason === 'new_sessions_only') key = 'newSessionsOnly';
    else if (input.machineOnline === null) key = 'saved';
    else if (!input.machineOnline) key = 'offline';
    else if (timing?.t === 'restart_to_apply') {
        const by = timing.restartBy;
        key = by === 'terminal' ? 'restartTerminal' : 'restart';
        if (by === 'user') restart = input.turnSettled ? 'enabled' : 'disabled';
    } else if (timing?.t === 'new_sessions_only') key = 'newSessionsOnly';
    else if (timing?.t === 'session_not_running') key = 'nextStart';
    else if (!timing || timing.t !== 'applied_now' && timing.t !== 'next_turn' || change?.state === 'inherit') key = 'saved';
    else if (rulesChanged) key = timing.t === 'applied_now' ? 'appliedNow' : 'pendingNextTurn';
    else if (timing.t === 'applied_now' && !change) key = 'saved';
    else if (change) key = timing?.t === 'applied_now' ? change.state === 'off' ? 'removedNow' : 'addedNow'
        : change.state === 'off' ? 'leavesNextTurn' : 'joinsNextTurn';
    else key = 'pendingNextTurn';
    const item = change?.title ?? '';
    const text = input.translate ? input.translate(`capabilities.session.apply.${key}`, { item, machine: input.machineName })
        : t(`capabilities.session.apply.${key}`, { item, machine: input.machineName });
    return { key, text, restart };
}

/** A saved result stays tied to this skill's actual acknowledgment, never a live-reload declaration. */
export function sessionSkillApplyNotice(input: Readonly<{
    facts: SessionSkillApplicationFacts; title: string; sessionRunning: boolean;
    inclusion?: SessionCapabilitiesSetOutputV1;
    applyTiming: CapabilityApplyTimingV1 | null;
    machineOnline: boolean | null; machineName: string; turnSettled: boolean;
}>): SessionCapabilityApplyNotice | null {
    const refusedNewSession = input.facts.desired === 'inherit' && input.inclusion?.ok === false
        && input.inclusion.code === 'applies_to_new_sessions_only';
    if (input.facts.desired !== 'on' && !refusedNewSession) return null;
    const pending = input.facts.pending || refusedNewSession;
    // A declaration that live reload is supported is not its receipt. While this
    // id is unacknowledged, only the runner's pending/refusal record explains it.
    const pendingRecord = refusedNewSession ? { reason: 'new_sessions_only' }
        : pending && input.facts.reason !== 'applied_now' ? input.facts : undefined;
    const timing = !input.sessionRunning ? { t: 'session_not_running' as const }
        : !pending ? { t: 'applied_now' as const }
        : input.applyTiming?.t === 'applied_now' ? null : input.applyTiming;
    return sessionCapabilityApplyNotice({ ...input,
        pendingApply: { mcp: false, skills: true },
        applyTiming: timing ? { mcp: timing, skills: timing } : null,
        change: { kind: 'skill', title: input.title, state: 'on', ...(input.sessionRunning || refusedNewSession ? pendingRecord : undefined) },
    });
}
