import { buildExistingSessionCapabilitiesActionInput } from '@happier-dev/protocol/sessions/authoring/existingSessionActionInputs';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { readPendingCapabilityApplyV1, readCapabilitySelectionApplyV1, readSessionCapabilitySelectionFromMetadataV1, readAppliedSessionCapabilitySelectionFromMetadataV1, readPendingCapabilityRuleApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { readSessionCapabilityOverrideV1, setSessionCapabilitySelectionItemV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionCapabilitiesSetOutputV1Schema, type SessionCapabilitiesSetInputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readSessionCapabilityAgentFactsV1, readCapabilityLaunchRestartFromMetadataV1, resolveCapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { useSessionSelector } from '@/sync/store/hooks';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSessionCapabilityItemSelected, useSessionCapabilitiesQuery, useSessionSkillSelected } from './sessionCapabilitiesQuery';

/** Read-only demand shares the pane's Account-qualified Session capability query. */
export function useSessionSkillCount(sessionId: string, serverId: string): number | null {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const query = useSessionCapabilitiesQuery(sessionId, binding);
    React.useEffect(() => { void query.demandPreview(); }, [query.demandPreview]);
    return useSessionSelector(sessionId, serverId, (session: Session | null) => {
        if (query.status !== 'ready' || !query.preview) return null;
        const selection = readSessionCapabilitySelectionFromMetadataV1(session ? readSessionOwnerMetadataView(session) : null);
        return query.preview.skills.items.filter(item => resolveSessionCapabilityItemSelected(item,
            readSessionCapabilityOverrideV1(selection, 'skill', item.id))).length;
    });
}

type ItemKind = SessionCapabilitiesSetInputV1['kind'];
type ItemState = SessionCapabilitiesSetInputV1['state'];
/** `previous` is the override the Action replaced (IR-77): what Undo resends, and what tells an add from a removal. */
export type SessionCapabilityWriteResult = Readonly<{ ok: true; state: ItemState; previous: ItemState }> | Readonly<{ ok: false; message: string }>;
// A queued write keeps its initiating command, independently of later UI or agent operations.
type Operation = Readonly<{ kind: ItemKind; id: string; state: ItemState; reason?: string;
    invocation?: CurrentUiContextCommandInvocation;
    resolve: (value: SessionCapabilityWriteResult) => void }>;
type State = { key: string; metadata: unknown; written: SessionCapabilitySelectionV1; selection: SessionCapabilitySelectionV1;
    pending: Operation[]; running: boolean; mounted: boolean;
    previous: Readonly<{ kind: ItemKind; id: string; state: ItemState }> | null };

/** Scalar facts keep one saved result independent of other capability and Artifact arrivals. */
export function readSessionSkillApplicationFacts(metadata: unknown, skillId: string) {
    const desired = readSessionCapabilityOverrideV1(readSessionCapabilitySelectionFromMetadataV1(metadata), 'skill', skillId);
    const applied = readSessionCapabilityOverrideV1(readAppliedSessionCapabilitySelectionFromMetadataV1(metadata), 'skill', skillId);
    const pending = desired !== applied || readPendingCapabilityRuleApplyV1(metadata, 'skills');
    const record = pending ? readCapabilitySelectionApplyV1(metadata).skills : undefined;
    return { desired, pending, reason: record?.reason, restartBy: record?.restartBy };
}
export type SessionSkillApplicationFacts = ReturnType<typeof readSessionSkillApplicationFacts>;

/** Passive pushed-state projection: no preview demand, optimistic queue, or library reads. */
export function useSessionSkillApplicationFacts(sessionId: string, skillId: string, serverId: string) {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const nextRefresh = React.useCallback((nowMs: number) => {
        const state = readRegisteredStorageState();
        const session = state ? selectHomeQualifiedSession(state, sessionId, serverId, getActiveServerSnapshot().serverId) : null;
        return session ? readSessionStatusNextRefreshAtMs(session, nowMs) : null;
    }, [sessionId, serverId]);
    const subscribeDeadlines = React.useCallback((listener: () => void) => subscribeRegisteredStorageState(listener, {
        sessions: [sessionId], sessionListRowsByServerId: true, sessionLocalStateScope: true,
    }) ?? (() => {}), [sessionId]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(nextRefresh, sessionId.length > 0, undefined, subscribeDeadlines);
    const facts = useSessionSelector(sessionId, serverId, useShallow((session: Session | null) => {
        const metadata = session ? readSessionOwnerMetadataView(session) : null;
        const agent = readSessionCapabilityAgentFactsV1(metadata);
        const timing = session && agent ? resolveCapabilityApplyTimingV1({ kind: 'skill', agent,
            sessionRunning: session.active, launchRestart: readCapabilityLaunchRestartFromMetadataV1(metadata) }) : null;
        const awareness = session ? projectUiSessionAwareness(session, Math.max(nowMs, Date.now()), { includeTitle: false, includeWorkspace: false }) : null;
        return { ...readSessionSkillApplicationFacts(metadata, skillId),
            running: session?.active ?? null,
            machineId: resolveSessionMachineId(metadata),
            timing: timing?.t ?? null, timingRestartBy: timing?.t === 'restart_to_apply' ? timing.restartBy : null,
            turnSettled: awareness !== null && !awareness.operational.reasons.some(reason => reason === 'working'
                || reason === 'permission_required' || reason === 'action_required'),
        };
    }));
    const selected = useSessionSkillSelected(sessionId, binding, skillId, facts.desired);
    return { ...facts, selected };
}

/** One Account-qualified pushed-state reader for capability consumers. */
function useSessionCapabilityReader(sessionId: string, serverId?: string | null, suppliedMetadata?: unknown) {
    const active = useActiveServerSnapshot(!serverId);
    const { binding } = useServerCredentialAccountScopeBinding(serverId ?? active.serverId);
    const subscribe = React.useCallback((listener: () => void) => suppliedMetadata !== undefined
        ? () => {} : subscribeRegisteredStorageState(listener, {
            sessions: [sessionId], sessionListRowsByServerId: true, sessionLocalStateScope: true,
        }) ?? (() => {}), [suppliedMetadata, sessionId]);
    const readSession = React.useCallback(() => {
        const registered = readRegisteredStorageState();
        return registered && binding && areServerAccountScopesEqual(registered.sessionLocalStateScope, binding.scope)
            ? selectHomeQualifiedSession(registered, sessionId, binding.scope.serverId, active.serverId) : null;
    }, [sessionId, binding?.scope.serverId, binding?.scope.accountId, active.serverId]);
    return { binding, subscribe, readSession };
}

/** Session overrides have one optimistic queue; every durable change and Undo goes through the public Action. */
export function useSessionCapabilities(sessionId: string, suppliedMetadata?: unknown,
    options?: Readonly<{ serverId?: string | null }>) {
    const { binding, subscribe, readSession } = useSessionCapabilityReader(sessionId, options?.serverId, suppliedMetadata);
    const readMetadata = React.useCallback(() => {
        if (suppliedMetadata !== undefined) return suppliedMetadata;
        const session = readSession();
        return session ? readSessionOwnerMetadataView(session) : null;
    }, [suppliedMetadata, readSession]);
    const readRunning = React.useCallback(() => readSession()?.active ?? null, [readSession]);
    const sessionMetadata = React.useSyncExternalStore(subscribe, readMetadata, readMetadata);
    const sessionRunning = React.useSyncExternalStore(subscribe, readRunning, readRunning);
    const execution = useMountedActionExecution(binding?.scope);
    const key = JSON.stringify([binding?.scope.serverId, binding?.scope.accountId, sessionId]);
    const [, render] = React.useState(0);
    const owner = React.useRef<State | null>(null);
    if (!owner.current || owner.current.key !== key) {
        const selection = readSessionCapabilitySelectionFromMetadataV1(sessionMetadata);
        owner.current = { key, metadata: sessionMetadata, written: selection, selection, pending: [], running: false, mounted: true, previous: null };
    }
    const state = owner.current;
    const [demanded, setDemanded] = React.useState(false);
    const { preview, status, error, refresh, demandPreview } = useSessionCapabilitiesQuery(sessionId, binding);
    const publish = React.useCallback((current: State) => {
        const selection = current.pending.reduce((value, op) => setSessionCapabilitySelectionItemV1(value, op.kind, op.id, op.state), current.written);
        if (JSON.stringify(selection) === JSON.stringify(current.selection)) return;
        current.selection = selection;
        if (owner.current === current && current.mounted) render(value => value + 1);
    }, []);
    React.useEffect(() => { state.mounted = true; return () => { state.mounted = false; }; }, [state]);
    React.useLayoutEffect(() => {
        if (state.metadata === sessionMetadata) return;
        state.metadata = sessionMetadata;
        state.written = readSessionCapabilitySelectionFromMetadataV1(sessionMetadata);
        publish(state);
    }, [state, sessionMetadata, publish]);
    React.useEffect(() => { if (demanded && execution.ready) void demandPreview(); }, [demanded, execution.ready, demandPreview]);
    const drain = React.useCallback(async (current: State) => {
        if (current.running) return;
        current.running = true;
        while (current.pending.length) {
            const op = current.pending[0]!;
            let outcome: SessionCapabilityWriteResult;
            try {
                if (owner.current !== current || !current.mounted) outcome = { ok: false, message: 'scope-retired' };
                else {
                    const input = buildExistingSessionCapabilitiesActionInput({ sessionId, kind: op.kind, id: op.id, state: op.state,
                        ...(op.reason !== undefined ? { reason: op.reason } : {}) });
                    const result = await (op.invocation
                        ? op.invocation.execute(execution, 'session.capabilities.set', input)
                        : execution.execute('session.capabilities.set', input, { defaultSessionId: sessionId }));
                    const parsed = result.ok ? SessionCapabilitiesSetOutputV1Schema.safeParse(result.result) : null;
                    if (parsed?.success && parsed.data.ok) {
                        current.written = setSessionCapabilitySelectionItemV1(current.written, op.kind, op.id, parsed.data.state);
                        current.previous = { kind: op.kind, id: op.id, state: parsed.data.previous };
                        outcome = { ok: true, state: parsed.data.state, previous: parsed.data.previous };
                    } else outcome = { ok: false, message: !result.ok ? result.errorCode ?? result.error
                        : parsed?.success && !parsed.data.ok ? parsed.data.code : 'invalid_action_output' };
                }
            } catch (failure) { outcome = { ok: false, message: failure instanceof Error ? failure.message : String(failure) }; }
            current.pending.shift(); publish(current); op.resolve(outcome);
        }
        current.running = false;
        if (demanded && owner.current === current && current.mounted) void refresh();
    }, [execution.execute, execution.executeForCaller, execution.binding, sessionId, publish, demanded, refresh]);
    const setItem = React.useCallback((kind: ItemKind, id: string, value: ItemState, reason?: string,
        invocation?: CurrentUiContextCommandInvocation): Promise<SessionCapabilityWriteResult> => {
        if (owner.current !== state || !state.mounted) return Promise.resolve({ ok: false, message: 'scope-retired' });
        return new Promise(resolve => { state.pending.push({ kind, id, state: value, reason, invocation, resolve }); publish(state); void drain(state); });
    }, [state, drain, publish]);
    const undoLast = React.useCallback((invocation?: CurrentUiContextCommandInvocation) => state.previous
        ? setItem(state.previous.kind, state.previous.id, state.previous.state, undefined, invocation)
        : Promise.resolve({ ok: true as const }), [state, setItem]);
    // Desired/applied metadata is the host's current acknowledgment. A last-known
    // Machine preview may still describe the previous pending change.
    const pendingApply = React.useMemo(() => {
        const currentPending = readPendingCapabilityApplyV1(sessionMetadata);
        if (sessionMetadata === null || sessionMetadata === undefined) return preview?.pendingApply ?? currentPending;
        const currentApply = readCapabilitySelectionApplyV1(sessionMetadata);
        // The aggregate notice selects MCP first when both kinds are pending.
        // Never label it with the other kind's refusal while its own record is absent.
        const refusal = currentPending.mcp ? currentApply.mcp : currentApply.skills;
        return { ...currentPending, ...(refusal ? { reason: refusal.reason, ...(refusal.restartBy ? { restartBy: refusal.restartBy } : {}) } : {}) };
    }, [sessionMetadata, preview?.pendingApply]);
    // Apply notices read the host's admitted facts even before the detail preview is demanded.
    const applyTiming = React.useMemo(() => {
        const agent = readSessionCapabilityAgentFactsV1(sessionMetadata);
        if (!agent || sessionRunning === null) return preview?.applyTiming ?? null;
        const input = { agent, sessionRunning, launchRestart: readCapabilityLaunchRestartFromMetadataV1(sessionMetadata) };
        return { mcp: resolveCapabilityApplyTimingV1({ ...input, kind: 'mcp_server' }),
            skills: resolveCapabilityApplyTimingV1({ ...input, kind: 'skill' }) };
    }, [sessionMetadata, sessionRunning, preview?.applyTiming]);
    const demand = React.useCallback(() => { setDemanded(true); void demandPreview(); }, [demandPreview]);
    return { sessionId, scopeKey: key, metadata: sessionMetadata, selection: state.selection, items: preview ? { mcp: preview.mcp.items, skills: preview.skills.items } : null,
        pendingApply, applyTiming,
        preview, lastKnownPreview: preview, status, error, setItem, undoLast, demandPreview: demand, refresh };
}
