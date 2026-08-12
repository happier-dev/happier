import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import {
    AGENT_ACTIVITY_ROW_NO_ACTIONS,
    type AgentActivityRowEntry,
} from '@/components/sessions/agentActivity/agentActivityRowEntry';
import type { Message, ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer, type ReducerMessage, type ReducerState } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';

import type { TestkitSessionMessagesState } from '../mocks/sessionMessagesHooks';
import { createSessionFixture } from './sessionFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from './transcriptFixtures';

/**
 * Agent-activity session fixtures.
 *
 * These build the exact shapes the production derivation accepts — `deriveSessionSubagents`
 * (transcript tool calls) and `deriveSessionSubagentActivityPreview` /
 * `deriveSessionSubagentPendingPermissionIds` (reducer sidechains) — so an agent-surface test
 * observes real derivation rather than a hand-shaped roster.
 *
 * Reseeding one session id with a different roster inside a file also needs
 * `clearSessionTranscriptDerivedCachesForSession(sessionId)`: every fixture ships
 * `subagentSourceVersion: 1`, and `useSessionSubagentSourceMessages` caches per session on exactly
 * that version, so the second seed would otherwise be served the first one's messages.
 */

/**
 * The presentation-side counterpart to the session fixtures below: one unit of agent work as the
 * row and the list consume it.
 *
 * It exists because the two halves of the agent-activity stack are tested at different seams. The
 * session fixtures feed the *derivation* (`deriveSessionSubagents` and friends) so a surface test
 * observes real derivation instead of a hand-shaped roster. The row and the list sit downstream of
 * a merge (`deriveAgentActivityEntries`) that does not exist yet, so their tests state the entry
 * directly — and they should state it through one shared builder rather than each re-deriving the
 * required shape, which is how two subtly different notions of "an entry" get started.
 *
 * `makeAgentActivityRosterFixture` deliberately keeps entry identity stable across calls with the
 * same input, because referential stability is the property the rows are memoized on (INV-4).
 */
export function makeAgentActivityRowEntryFixture(
    overrides: Partial<AgentActivityRowEntry> & Pick<AgentActivityRowEntry, 'id'>,
): AgentActivityRowEntry {
    return {
        status: 'running',
        title: overrides.id,
        actions: AGENT_ACTIVITY_ROW_NO_ACTIONS,
        ...overrides,
    };
}

/**
 * A roster of `count` entries, cycling through `statuses` and starting one second apart.
 *
 * Sized rosters (0, 1, 3, 40) are the interesting cases for partitioning, ordering and the finished
 * cap, and writing them out by hand hides the one variable that matters in a wall of literals.
 */
export function makeAgentActivityRosterFixture(params: Readonly<{
    count: number;
    statuses?: readonly AgentActivityStatusV1[];
    startedAtMs?: number;
    idPrefix?: string;
}>): readonly AgentActivityRowEntry[] {
    const statuses = params.statuses ?? (['running'] as const);
    const startedAtMs = params.startedAtMs ?? 1_000;
    const idPrefix = params.idPrefix ?? 'entry';

    return Array.from({ length: params.count }, (_, index) => {
        const status = statuses[index % statuses.length]!;
        const started = startedAtMs + (index * 1_000);
        return makeAgentActivityRowEntryFixture({
            id: `${idPrefix}-${index}`,
            status,
            startedAtMs: started,
            ...(isTerminalFixtureStatus(status) ? { endedAtMs: started + 500 } : {}),
        });
    });
}

function isTerminalFixtureStatus(status: AgentActivityStatusV1): boolean {
    return status === 'succeeded'
        || status === 'failed'
        || status === 'timedOut'
        || status === 'cancelled';
}

export type AgentActivityFixtureStatus = 'running' | 'succeeded' | 'failed' | 'unknown';

const TOOL_STATE_BY_FIXTURE_STATUS = {
    running: 'running',
    succeeded: 'completed',
    failed: 'error',
    unknown: 'unavailable',
} as const satisfies Record<AgentActivityFixtureStatus, ToolCall['state']>;

/** A `SubAgent` transcript tool call plus its sidechain, i.e. one `subagent_sidechain` entry. */
export type AgentActivityFixtureSubagent = Readonly<{
    /** Short local key; the sidechain id and subagent id are derived from it. */
    key: string;
    title?: string;
    status?: AgentActivityFixtureStatus;
    /** Latest sidechain line, surfaced by `deriveSessionSubagentActivityPreview`. */
    activity?: string;
    /** Emits a pending sidechain permission for `deriveSessionSubagentPendingPermissionIds`. */
    pendingPermission?: boolean;
    createdAt?: number;
}>;

/** A `SubAgentRun` transcript tool call, i.e. one `execution_run` entry. */
export type AgentActivityFixtureExecutionRun = Readonly<{
    runId: string;
    label?: string;
    intent?: string;
    backendId?: string;
    status?: Exclude<AgentActivityFixtureStatus, 'unknown'>;
    activity?: string;
    createdAt?: number;
}>;

/**
 * A Claude agent-team teammate, as the transcript actually records one.
 *
 * The kind has no CLI publisher: its status is a MEMBERSHIP SNAPSHOT derived from these tool calls
 * (`deriveClaudeTeamParticipants`), which is why a fixture has to speak in messages rather than in
 * a published entry the way `workflow_agent` can.
 */
export type AgentActivityFixtureTeamMember = Readonly<{
    teamId: string;
    memberId: string;
    memberLabel?: string;
    createdAt?: number;
}>;

export function agentActivityFixtureSidechainId(key: string): string {
    return `toolu_${key}`;
}

export function agentActivityFixtureSubagentId(key: string): string {
    return `subagent_sidechain:${agentActivityFixtureSidechainId(key)}`;
}

export function agentActivityFixtureTeamMemberSubagentId(
    member: Readonly<{ teamId: string; memberId: string }>,
): string {
    return `agent_team_member:${member.teamId}:${member.memberId}`;
}

export function makeAgentActivityTeamMemberToolCallMessage(
    member: AgentActivityFixtureTeamMember,
): ToolCallMessage {
    const createdAt = member.createdAt ?? 1_000;
    const toolUseId = `toolu_team_${member.memberId}`;
    return createToolCallMessageFixture({
        id: `message_${toolUseId}`,
        localId: null,
        createdAt,
        tool: {
            id: toolUseId,
            name: 'Task',
            state: 'running',
            input: {
                team_name: member.teamId,
                agent_id: member.memberId,
                name: member.memberLabel ?? member.memberId,
            },
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
        },
    });
}

export function executionRunFixtureSidechainId(runId: string): string {
    return `call_${runId}`;
}

export function executionRunFixtureSubagentId(runId: string): string {
    return `execution_run:${runId}`;
}

export function makeAgentActivitySubagentToolCallMessage(
    subagent: AgentActivityFixtureSubagent,
): ToolCallMessage {
    const createdAt = subagent.createdAt ?? 1_000;
    const sidechainId = agentActivityFixtureSidechainId(subagent.key);
    const state = TOOL_STATE_BY_FIXTURE_STATUS[subagent.status ?? 'running'];
    return createToolCallMessageFixture({
        id: `message_${sidechainId}`,
        localId: null,
        createdAt,
        tool: {
            id: sidechainId,
            name: 'SubAgent',
            state,
            input: { name: subagent.title ?? subagent.key },
            createdAt,
            startedAt: createdAt,
            completedAt: state === 'running' ? null : createdAt + 1,
            description: null,
        },
    });
}

export function makeAgentActivityExecutionRunToolCallMessage(
    run: AgentActivityFixtureExecutionRun,
): ToolCallMessage {
    const createdAt = run.createdAt ?? 1_000;
    const sidechainId = executionRunFixtureSidechainId(run.runId);
    const state = TOOL_STATE_BY_FIXTURE_STATUS[run.status ?? 'running'];
    return createToolCallMessageFixture({
        id: `message_${sidechainId}`,
        localId: null,
        createdAt,
        tool: {
            id: sidechainId,
            name: 'SubAgentRun',
            state,
            input: {
                runId: run.runId,
                sidechainId,
                label: run.label ?? run.runId,
                ...(run.intent ? { intent: run.intent } : {}),
                ...(run.backendId ? { backendId: run.backendId } : {}),
            },
            createdAt,
            startedAt: createdAt,
            completedAt: state === 'running' ? null : createdAt + 1,
            description: null,
            ...(state === 'running' ? {} : { result: { runId: run.runId, sidechainId } }),
        },
    });
}

export function makeAgentActivitySidechainMessage(params: Readonly<{
    id: string;
    createdAt?: number;
    text?: string | null;
    toolName?: string;
    toolDescription?: string | null;
    permissionStatus?: 'pending' | 'approved' | 'denied' | 'canceled';
}>): ReducerMessage {
    const createdAt = params.createdAt ?? 1_000;
    const tool: ToolCall | null = params.toolName || params.permissionStatus
        ? {
            id: `${params.id}_tool`,
            name: params.toolName ?? 'Read',
            state: 'running',
            input: {},
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: params.toolDescription ?? null,
            ...(params.permissionStatus
                ? {
                    permission: {
                        id: `${params.id}_permission`,
                        status: params.permissionStatus,
                        kind: 'permission',
                    },
                }
                : {}),
        }
        : null;

    return {
        id: params.id,
        realID: params.id,
        seq: null,
        localId: null,
        createdAt,
        role: 'agent',
        text: params.text ?? null,
        event: null,
        tool,
    };
}

/** A real `ReducerState` (not a look-alike) carrying the supplied sidechain entries. */
export function makeAgentActivityReducerState(
    sidechainsBySidechainId: Readonly<Record<string, readonly ReducerMessage[]>>,
): ReducerState {
    const reducerState = createReducer();
    for (const [sidechainId, messages] of Object.entries(sidechainsBySidechainId)) {
        reducerState.sidechains.set(sidechainId, [...messages]);
    }
    return reducerState;
}

export type SessionAgentActivityFixtureOptions = Readonly<{
    sessionId?: string;
    flavor?: string;
    subagents?: readonly AgentActivityFixtureSubagent[];
    executionRuns?: readonly AgentActivityFixtureExecutionRun[];
    teamMembers?: readonly AgentActivityFixtureTeamMember[];
    session?: Partial<Session>;
}>;

export type SessionAgentActivityFixture = Readonly<{
    sessionId: string;
    session: Session;
    messages: readonly Message[];
    reducerState: ReducerState;
    /** Store-shaped entry for `storage.setState({ sessionMessages })`. */
    sessionMessages: SessionMessages;
    /** Hook-shaped state for `createSessionMessagesHooksMock({ bySessionId })`. */
    sessionMessagesState: TestkitSessionMessagesState;
    sessionMessagesBySessionId: Readonly<Record<string, TestkitSessionMessagesState>>;
    storeSessionMessagesBySessionId: Readonly<Record<string, SessionMessages>>;
}>;

/** Composes N subagents and execution runs in assorted states into one session's state. */
export function makeSessionAgentActivityFixture(
    options: SessionAgentActivityFixtureOptions = {},
): SessionAgentActivityFixture {
    const sessionId = options.sessionId ?? 'session-agent-activity';
    const messages: Message[] = [];
    const sidechains: Record<string, ReducerMessage[]> = {};

    for (const subagent of options.subagents ?? []) {
        messages.push(makeAgentActivitySubagentToolCallMessage(subagent));
        const sidechainId = agentActivityFixtureSidechainId(subagent.key);
        const sidechainMessages: ReducerMessage[] = [];
        if (subagent.activity) {
            sidechainMessages.push(makeAgentActivitySidechainMessage({
                id: `${sidechainId}_activity`,
                createdAt: (subagent.createdAt ?? 1_000) + 1,
                text: subagent.activity,
                ...(subagent.pendingPermission ? { permissionStatus: 'pending' as const } : {}),
            }));
        } else if (subagent.pendingPermission) {
            sidechainMessages.push(makeAgentActivitySidechainMessage({
                id: `${sidechainId}_permission`,
                createdAt: (subagent.createdAt ?? 1_000) + 1,
                permissionStatus: 'pending',
            }));
        }
        if (sidechainMessages.length > 0) sidechains[sidechainId] = sidechainMessages;
    }

    for (const run of options.executionRuns ?? []) {
        messages.push(makeAgentActivityExecutionRunToolCallMessage(run));
        if (!run.activity) continue;
        sidechains[executionRunFixtureSidechainId(run.runId)] = [
            makeAgentActivitySidechainMessage({
                id: `${executionRunFixtureSidechainId(run.runId)}_activity`,
                createdAt: (run.createdAt ?? 1_000) + 1,
                text: run.activity,
            }),
        ];
    }

    for (const member of options.teamMembers ?? []) {
        messages.push(makeAgentActivityTeamMemberToolCallMessage(member));
    }

    const reducerState = makeAgentActivityReducerState(sidechains);
    const messagesById: Record<string, Message> = {};
    for (const message of messages) messagesById[message.id] = message;

    const sessionMessages = createSessionMessagesFixture({
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById,
        messagesMap: messagesById,
        reducerState,
        messagesVersion: 1,
        subagentSourceVersion: 1,
        isLoaded: true,
    });
    const sessionMessagesState: TestkitSessionMessagesState = {
        messages,
        isLoaded: true,
        reducerState,
    };
    const session = createSessionFixture({
        id: sessionId,
        active: true,
        ...options.session,
        metadata: {
            flavor: options.flavor ?? 'claude',
            ...(options.session?.metadata ?? {}),
        } as Session['metadata'],
    });

    return {
        sessionId,
        session,
        messages,
        reducerState,
        sessionMessages,
        sessionMessagesState,
        sessionMessagesBySessionId: { [sessionId]: sessionMessagesState },
        storeSessionMessagesBySessionId: { [sessionId]: sessionMessages },
    };
}
