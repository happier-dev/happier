import { expect, it } from 'vitest';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createMcpAlwaysAllowController } from './mcpAlwaysAllow';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { applyMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';

it('retains the applied native answer after retirement and retries only its failed offered catalog Action', async () => {
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'docs', tool: 'mutate', item: { serverId: 'docs' }, serverTitle: 'Docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    const followUp = { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { mutate: 'allow' } } };
    let pending = true; let answers = 0; let saves = 0;
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'docs', name: 'docs', transport: 'stdio',
        stdio: { command: 'docs-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] };
    const executor = createActionExecutor({
        sessionStatusGet: async () => ({ pendingRequests: pending ? [{ requestId: 'request', kind: 'permission', tool: 'McpTool',
            nativeChoices: { requirementId: 'occurrence', source: 'test-agent', choices: [{ id: 'remember', label: 'Remember',
                decision: 'approved', scope: 'session', response: { approved: true }, followUp }] } }] : [] }),
        sessionPermissionRespond: async () => { answers++; pending = false; return { ok: true }; },
        mcpServerAction: createMcpServerActionExecuteV1({
            readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
                readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: projectNativeJsonValueForTransport(catalog) } }) }),
            mutate: async change => { if (++saves === 1) return { status: 'conflict', revision: 1 };
                catalog = applyMcpServerCatalogMutationV1(catalog, change); return { status: 'updated', revision: 2, cursor: 2 }; },
            machine: async () => { throw new Error('Catalog consent never starts a process'); },
        }),
    });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', runtimeAccountId: 'account' };
    const controller = createMcpAlwaysAllowController({ identity, followUp,
        answerForSession: async () => { requireActionSuccess(await executor.execute('session.permission.respond', {
            sessionId: 'session', requestId: 'request', nativeChoice: { requirementId: 'occurrence', choiceId: 'remember' },
        }, context)); }, execute: (id, input) => executor.execute(id, input, context) });
    await controller.allow();
    expect(pending).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ status: 'save_failed', answered: true, followUp });
    const remounted = createMcpAlwaysAllowController({ identity,
        answerForSession: async () => { throw new Error('Retired occurrence cannot be answered again'); },
        execute: (id, input) => executor.execute(id, input, context) }, controller.getSnapshot());
    await remounted.allow();
    expect(remounted.getSnapshot().status).toBe('saved');
    expect(catalog.servers[0]).toMatchObject({ tools: { overrides: { mutate: 'allow' } } });
    expect(answers).toBe(1); expect(saves).toBe(2);
    const successful = createMcpAlwaysAllowController({ identity, followUp,
        answerForSession: async () => {}, execute: async () => { throw new Error('Core already saved the offered follow-up'); } });
    await successful.allow();
    expect(successful.getSnapshot().status).toBe('saved');
});

it('does not claim persistence before the exact plugin-item write is acknowledged; concurrent taps share that write', async () => {
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'plugin-team', tool: '__proto__', item: { serverId: 'plugin:acme.team/docs',
        plugin: { pluginId: 'acme.team', localId: 'docs' } }, serverTitle: 'Team docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    const pending = createDeferred<{ ok: true; result: unknown }>();
    const writes: unknown[] = [];
    let answers = 0;
    const controller = createMcpAlwaysAllowController({ identity, answerForSession: async () => { answers++; },
        execute: async (_actionId, input) => { writes.push(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse(input)); return pending.promise; } });
    const first = controller.allow(); const second = controller.allow();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ status: 'saving', answered: true });
    expect(writes).toEqual([{ serverId: 'plugin:acme.team/docs', tools: JSON.parse('{"__proto__":"allow"}') }]);
    pending.resolve({ ok: true, result: MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse({ revision: 2, previous: { tools: { ['__proto__']: 'inherit' } } }) });
    await first; await second;
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved' });
    expect(answers).toBe(1); expect(writes).toHaveLength(1);
});

it('never writes a persistent setting after a failed permission answer', async () => {
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'github', tool: 'delete_file', item: { serverId: 'github' }, serverTitle: 'GitHub',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    let writes = 0;
    const controller = createMcpAlwaysAllowController({ identity, answerForSession: async () => { throw new Error('Offline'); },
        execute: async () => { writes++; return { ok: false, error: 'must_not_write', errorCode: 'must_not_write' }; } });
    await controller.allow();
    expect(controller.getSnapshot()).toMatchObject({ status: 'answer_failed', answered: false });
    expect(writes).toBe(0);
});

it('retries only the catalog save after a conflict or malformed success, and excludes the built-in server', async () => {
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'github', tool: 'delete_file', item: { serverId: 'github' }, serverTitle: 'GitHub',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    let answers = 0;
    const receipts = [
        { ok: false as const, errorCode: 'mcp_catalog_conflict', error: 'mcp_catalog_conflict' },
        { ok: true as const, result: { status: 'updated', revision: 2 } },
        { ok: true as const, result: MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse({ revision: 2, previous: { tools: { delete_file: 'inherit' } } }) },
    ];
    const controller = createMcpAlwaysAllowController({ identity, answerForSession: async () => { answers++; },
        execute: async () => receipts.shift()! });
    await controller.allow();
    expect(controller.getSnapshot()).toMatchObject({ status: 'save_failed', answered: true, errorCode: 'mcp_catalog_conflict' });
    await controller.allow();
    expect(controller.getSnapshot()).toMatchObject({ status: 'save_failed', errorCode: 'invalid_action_output' });
    await controller.allow();
    expect(controller.getSnapshot().status).toBe('saved');
    expect(answers).toBe(1);
    const builtIn = createMcpAlwaysAllowController({ identity: { ...identity, server: 'happier' },
        answerForSession: async () => { throw new Error('Must not answer'); }, execute: async () => { throw new Error('Must not write'); } });
    await expect(builtIn.allow()).rejects.toThrow('mcp_always_allow_unavailable');
    expect(builtIn.getSnapshot().status).toBe('idle');
});
