import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { ResolvedMcpToolIdentityV1Schema, type ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';

export type McpAlwaysAllowSnapshot = Readonly<{
    status: 'idle' | 'answering' | 'saving' | 'saved' | 'answer_failed' | 'save_failed';
    answered: boolean;
    errorCode: string | null;
}>;
export type McpAlwaysAllowInput = Readonly<{
    identity: ResolvedMcpToolIdentityV1;
    answerForSession(): Promise<void>;
    execute(actionId: 'mcp.servers.tools.set', input: Readonly<{ serverId: string; tools: Readonly<Record<string, 'allow'>> }>): Promise<ActionExecuteResult>;
}>;

/** Answers use the incumbent Session owner. Only the catalog write is retried after an answer. */
export function createMcpAlwaysAllowController(input: McpAlwaysAllowInput, receipt?: McpAlwaysAllowSnapshot) {
    const identity = ResolvedMcpToolIdentityV1Schema.parse(input.identity);
    let snapshot: McpAlwaysAllowSnapshot = receipt ?? { status: 'idle', answered: false, errorCode: null };
    let inFlight: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    const publish = (next: McpAlwaysAllowSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
    const allow = (): Promise<void> => {
        if (inFlight) return inFlight;
        if (snapshot.status === 'saved') return Promise.resolve();
        if (identity.server === 'happier') return Promise.reject(new Error('mcp_always_allow_unavailable'));
        inFlight = (async () => {
            if (!snapshot.answered) {
                publish({ status: 'answering', answered: false, errorCode: null });
                try { await input.answerForSession(); }
                catch { publish({ status: 'answer_failed', answered: false, errorCode: 'permission_answer_failed' }); return; }
            }
            publish({ status: 'saving', answered: true, errorCode: null });
            try {
                const receipt = await input.execute('mcp.servers.tools.set', {
                    serverId: identity.item.serverId, tools: { [identity.tool]: 'allow' },
                });
                if (!receipt.ok) { publish({ status: 'save_failed', answered: true, errorCode: receipt.errorCode ?? 'mcp_catalog_operation_failed' }); return; }
                if (!MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].safeParse(receipt.result).success) {
                    publish({ status: 'save_failed', answered: true, errorCode: 'invalid_action_output' }); return;
                }
                publish({ status: 'saved', answered: true, errorCode: null });
            } catch { publish({ status: 'save_failed', answered: true, errorCode: 'mcp_catalog_operation_failed' }); }
        })().finally(() => { inFlight = null; });
        return inFlight;
    };
    return { allow, getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
