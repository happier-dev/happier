import { TodoSessionLinkInputV1Schema, projectTodoSessionLinkFailureV1, type TodoSessionLinkOutputV1 } from '@happier-dev/protocol';
import { applyTodoSessionLinkIntent } from '@/sync/domains/todos/todoOps';
import { sync } from '@/sync/sync';

/** Uses the accepted-create KV/CAS owner, including its current-Account admission. */
export async function executeTodoSessionLinkAction(args: Readonly<{ input: unknown; signal?: AbortSignal }>): Promise<TodoSessionLinkOutputV1> {
    const parsed = TodoSessionLinkInputV1Schema.safeParse(args.input);
    if (!parsed.success) return { status: 'refused', reason: 'invalid_input' };
    const credentials = sync?.getCredentials();
    if (!credentials) return { status: 'unavailable' };
    const { scope, taskId, session } = parsed.data;
    try {
        await applyTodoSessionLinkIntent(credentials, { source: { kind: 'zen_task', scope, taskId },
            session: { scope: { serverId: session.serverId, accountId: session.accountId }, sessionId: session.sessionId } }, { signal: args.signal });
        return { status: 'linked' };
    } catch (error) { return projectTodoSessionLinkFailureV1(error); }
}
