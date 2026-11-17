import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { AUTOMATION_OCCURRENCE_ACTION_IDS } from '@happier-dev/protocol/actions';
import { AutomationV3RunMutationResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createCliActionDeps } from './createCliActionDeps';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';

describe('CLI occurrence Action composition', () => {
    it.each(['cli', 'agent', 'mcp'] as const)('enforces Off and Allowed through %s ingress and sends one revisioned Home mutation', async surface => {
        const home = Fastify();
        const writes: Readonly<{ operation: string; body: unknown }>[] = [];
        const receipt = AutomationV3RunMutationResponseSchema.parse({ run: {
            id: 'run-1', automationId: 'automation-1', revision: 8, triggerId: null, triggerRetired: false,
            state: 'cancelled', cause: { kind: 'manual', invokedAt: 1 }, dueAt: 1,
            claimedAt: null, startedAt: null, finishedAt: 2, claimedByMachineId: null, leaseExpiresAt: null,
            attempt: 0, errorCode: null, producedSessionId: null, executionDispatchState: null,
            executionAttempt: 0, replyHandoffState: 'ready', replyHandoffAttempt: 0,
            replyHandoffDueAt: 2, createdAt: 1, updatedAt: 2,
        } });
        home.post('/v3/automations/runs/run-1/:operation', async request => {
            const { operation } = request.params as { operation: string };
            writes.push({ operation, body: request.body });
            return receipt;
        });
        const address = await home.listen({ host: '127.0.0.1', port: 0 });
        const mcpServer = new McpServer({ name: 'occurrence-contract', version: '1' });
        const client = new Client({ name: 'occurrence-contract', version: '1' });
        try {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null };
            let current = true;
            let policy = normalizeActionsSettingsV1({ v: 1, actions: {} });
            const deps = createCliActionDeps({ credentials, token, sessionId: '', mode: 'plain', ctx: null,
                serverId: 'home-a', serverHttpBaseUrl: address, isCredentialCurrent: async () => current });
            const executor = createActionExecutor({ ...deps,
                isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, policy, context),
                readActionsSettings: () => policy,
            });
            const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home-a', runtimeAccountId: 'account-a' };
            const bridge = createActionToolExecutorBridge({ executor, surface: surface === 'cli' ? 'agent' : surface });
            if (surface === 'mcp') {
                const inventory = createHappierToolInventory({ surface, isActionEnabled: () => true, actionsSettings: null });
                registerHappierMcpBuiltInTools(mcpServer, { sessionId: '', surface, getActionsSettings: () => policy,
                    toolInventory: prepareHappierMcpToolInventory({ sessionId: '', inventory: {
                        ...inventory, tools: inventory.tools.filter(tool => tool.name === 'action_execute'),
                    } }),
                    deps: { ...bridge, changeTitle: async () => ({ success: true }),
                        resolveActionOptions: args => bridge.resolveActionOptions(args, '') },
                });
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                await mcpServer.connect(serverTransport);
                await client.connect(clientTransport);
            }
            const invoke = async (actionId: typeof AUTOMATION_OCCURRENCE_ACTION_IDS[number], input: { runId: string; expectedRevision?: number }) => {
                if (surface === 'cli') return executor.execute(actionId, input, context);
                if (surface === 'agent') return bridge.executeActionByToolName('action_execute', { actionId, input }, '');
                const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
                const text = response.content.find(entry => entry.type === 'text');
                if (text?.type !== 'text') throw new Error('Missing occurrence MCP result');
                return response.isError ? { ok: false, ...JSON.parse(text.text) } : { ok: true, result: JSON.parse(text.text) };
            };
            for (const actionId of AUTOMATION_OCCURRENCE_ACTION_IDS) {
                const input = { runId: 'run-1', ...(actionId.endsWith('redeliver') ? { expectedRevision: 7 } : {}) };
                policy = normalizeActionsSettingsV1({ ...policy, actions: { [actionId]: { disabledSurfaces: [surface] } } });
                const before = writes.length;
                expect(await invoke(actionId, input)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
                expect(writes).toHaveLength(before);
                policy = setActionApprovalOverride({ settings: normalizeActionsSettingsV1({ v: 1, actions: {} }),
                    actionId, surface, approvalRequired: false });
                await expect(invoke(actionId, input)).resolves.toMatchObject({ ok: true, result: receipt });
                expect(writes).toHaveLength(before + 1);
            }
            expect(writes).toEqual([{ operation: 'retry-reply-handoff', body: undefined },
                { operation: 'deliver-result-again', body: { expectedRevision: 7 } }]);
            current = false;
            await expect(invoke('automation.run.result.redeliver', { runId: 'run-1', expectedRevision: 7 }))
                .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(writes).toHaveLength(2);
        } finally { await client.close(); await mcpServer.close(); await home.close(); }
    });

    it('retains a typed revision conflict without retrying the outward write', async () => {
        const home = Fastify();
        let writes = 0;
        home.post('/v3/automations/runs/run-1/deliver-result-again', async (_request, reply) => {
            writes += 1;
            return reply.code(409).send({ error: 'automation_run_revision_conflict' });
        });
        const address = await home.listen({ host: '127.0.0.1', port: 0 });
        try {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
            const deps = createCliActionDeps({ credentials: { token, encryption: null }, token,
                sessionId: '', mode: 'plain', ctx: null, serverId: 'home-a', serverHttpBaseUrl: address });
            const executor = createActionExecutor(deps);
            await expect(executor.execute('automation.run.result.redeliver', { runId: 'run-1', expectedRevision: 7 }, {
                surface: 'cli', authority: 'present_user', serverId: 'home-a', runtimeAccountId: 'account-a',
                presentUserConfirmation: { actionId: 'automation.run.result.redeliver' },
            })).resolves.toMatchObject({ ok: false, errorCode: 'automation_run_revision_conflict' });
            expect(writes).toBe(1);
        } finally { await home.close(); }
    });
});
