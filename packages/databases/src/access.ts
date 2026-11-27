import { isDelegatedActionRequesterV1, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    DatabaseAccessDecisionV1,
    DatabaseAccessSummaryV1,
    DatabaseAgentLevelV1,
    DatabaseOperationClassV1,
    DatabaseRequesterKindV1,
} from '@happier-dev/plugin-sdk/database';

/** Fold host-admitted caller facts once for database access; older hosts remain unavailable. */
export function resolveDatabaseRequesterKindV1(input: Readonly<{
    agentCaller?: boolean;
    authority?: PluginInvocationContext['authority'];
}>): DatabaseRequesterKindV1 | undefined {
    const { agentCaller, authority } = input;
    if (agentCaller === undefined || authority === undefined) return undefined;
    // Both facts are present here, so the shared predicate receives defined values only.
    return isDelegatedActionRequesterV1({ agentCaller, authority }) ? 'agent' : 'person';
}

export type DatabaseAccessInputV1 = Readonly<{
    /** Write facts from the target owner (Environment editors, worktree or Saved Secret admission). The person is
     * already admitted to read by that owner's existing read admission before any caller reaches this decision. */
    person: Readonly<{ mayWrite: boolean; editingOff: boolean }>;
    /** The D13 level. Ask vs no approval is the approval applier's input; here both write levels admit writes. */
    agentAccess: DatabaseAgentLevelV1;
    requester: DatabaseRequesterKindV1;
    operation: DatabaseOperationClassV1;
}>;

/**
 * The one database access decision (P3 M2/M6). A person gets write iff the target owner says so; an agent
 * gets the lesser of its person's class and the database's agent level.
 */
export function decideDatabaseAccessV1(input: DatabaseAccessInputV1): DatabaseAccessDecisionV1 {
    const access = summarizeDatabaseAccessV1(input);
    if (access.reason && (!access.canRead || input.operation === 'write')) return { ok: false, refusal: access.reason };
    return { ok: true, access: access.canWrite ? 'write' : 'read' };
}

function agentMayWrite(level: DatabaseAgentLevelV1): boolean {
    return level === 'readWriteAsk' || level === 'readWriteNoApproval';
}

/** `database.describe`'s display fold of the same decision. */
export function summarizeDatabaseAccessV1(input: Omit<DatabaseAccessInputV1, 'operation'>): DatabaseAccessSummaryV1 {
    if (input.requester === 'agent' && input.agentAccess === 'none') {
        return { canRead: false, canWrite: false, reason: 'database_agent_access_none' };
    }
    if (!input.person.mayWrite) {
        return { canRead: true, canWrite: false, reason: input.person.editingOff ? 'database_editing_off' : 'database_not_an_editor' };
    }
    if (input.requester === 'agent' && !agentMayWrite(input.agentAccess)) {
        return { canRead: true, canWrite: false, reason: 'database_agent_access_read_only' };
    }
    return { canRead: true, canWrite: true };
}
