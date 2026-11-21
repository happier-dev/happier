import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { evaluateUsageCoach } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { buildUsageCoachRemedies } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import { createSdkExecFixture, createEventsFixture, createPluginContextFixture,
    createTerminalHostFixture } from '../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeAgentSdkTurnOperations } from '../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { projectRuntimeTranscriptEvent, type RuntimeTranscriptProjectionSession } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';

describe('Claude native MCP witness → retained evidence → Coach remedy', () => {
    it.each(['native-connectors', 'deferred', 'missing', 'pending', 'hidden-task', 'queue-observed'] as const)(
        'admits only witnessed unused selected bindings (%s)', async shape => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            onTestFinished(() => vi.useRealTimers());
            const exec = createSdkExecFixture();
            const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
                { exec: exec.service });
            const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/qa/repository', launchEnv: {},
                permissionMode: 'default', happierSessionId: 'mcp-session', mcpServers: { docs: { command: 'docs-server' } } });
            // Host SDK services and the native process are the external boundaries.
            // Native translation, host projection, stored admission and Coach are real.
            const context = { session: { services: {
                activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
            } } } as unknown as AgentSessionRuntimeContext;
            const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
                { kind: 'create', sessionId: 'mcp-session', cwd: '/qa/repository' }, context);
            const retained: { id: string; createdAt: number; content: ReturnType<typeof buildAcpAgentMessageEnvelope> }[] = [];
            const writes: Promise<unknown>[] = [];
            const session: RuntimeTranscriptProjectionSession = { sessionId: 'mcp-session',
                enqueueAgentMessageCommitted: async (provider, body) => {
                    retained.push({ id: `row-${retained.length}`, createdAt: Date.now(),
                        content: buildAcpAgentMessageEnvelope({ provider, body }) });
                    return { persisted: true, delivered: false };
                } };
            const subscription = runtime.watch(event => {
                if (event.kind === 'mcp-tool-usage') writes.push(projectRuntimeTranscriptEvent({ session, provider: 'claude', event,
                    mcpServerIdentities: { docs: { serverId: 'server', serverTitle: 'Docs', usage: {
                        serverId: 'server', bindingId: 'binding', serverRevision: 10, bindingRevision: 20, catalogRevision: 40,
                    } } } }));
            });
            try {
                operations.beginProviderTurn('host-turn');
                await operations.sendProviderTurnPrompt('Reply ready without tools.');
                await exec.emit({ type: 'system', subtype: 'init', session_id: 'native-session',
                    tools: shape === 'deferred' || shape === 'missing' ? ['Read', 'ToolSearch']
                        : ['Read', 'mcp__docs__find', 'mcp__native_connector__find'],
                    mcp_servers: shape === 'missing' ? [] : [{ name: 'docs', status: shape === 'pending' ? 'pending' : 'connected' },
                        { name: 'native_connector', status: 'connected' }],
                });
                if (shape === 'hidden-task') {
                    await exec.emit({ type: 'system', subtype: 'task_started', task_id: 'child', session_id: 'native-session',
                        task_type: 'local_agent', is_backgrounded: true });
                    await exec.emit({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed',
                        session_id: 'native-session', summary: 'done' });
                }
                // Optional queue count follows the existing foreground completion rule.
                if (shape === 'queue-observed') {
                    await exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'queued',
                        session_id: 'native-session', usage: {}, modelUsage: {}, queued_turn_count: 1 });
                    expect(retained).toEqual([]);
                }
                await exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ready',
                    ...(shape === 'queue-observed' ? { queued_turn_count: 0 } : {}),
                    session_id: 'native-session', usage: {}, modelUsage: {} });
                await operations.waitForProviderTurnCompletion();
                await Promise.all(writes);
                const detail = projectSessionUsageWorkEvidence({ id: 'mcp-session', metadata: null, agentState: null }, retained);
                const usage = detail.coach?.detail?.mcpUsage;
                const complete = shape === 'native-connectors' || shape === 'deferred' || shape === 'queue-observed';
                expect(usage).toMatchObject([{ v: 2, coverage: complete ? 'complete' : 'partial', turnId: 'host-turn',
                    queuedTurnCount: shape === 'queue-observed' ? 0 : null,
                    bindings: [{ bindingId: 'binding', catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] }]);
                expect(JSON.stringify(retained)).not.toContain('native_connector');
                // The period ends exclusively. Include evidence retained at the observation clock.
                const asOfMs = Date.now();
                const evaluation = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 0, endMs: asOfMs + 1 }, asOfMs,
                    currentness: 'current', detail: detail.coach?.detail }, bundledUsageModelPriceCatalog);
                expect(evaluation.evaluations.find(row => row.detectorId === 'mcp_overhead')?.status)
                    .toBe(complete ? 'finding' : 'insufficient_evidence');
                const catalog: McpServerCatalogSnapshotV1 = { status: 'ready', authority: 'active', revision: 40, diagnostics: [],
                    catalog: { v: 1, servers: [{ id: 'server', name: 'docs', transport: 'stdio',
                        stdio: { command: 'docs-server', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
                        bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' },
                            agentId: 'claude', createdAt: 1, updatedAt: 20 }] } };
                const remedies = buildUsageCoachRemedies({ findings: evaluation.findings, composition: [], mcpUsage: usage,
                    serverId: 'home', mcpCatalog: catalog, sessions: [{ id: 'mcp-session', serverId: 'home', active: false,
                        ownerMetadata: {}, agentTarget: null, access: { capabilities: { submitAgentInput: true } } }] });
                expect(remedies).toEqual(complete ? [expect.objectContaining({ detectorId: 'mcp_overhead',
                    remedy: expect.objectContaining({ kind: 'mcp_binding', bindingId: 'binding', enabled: false, expectedRevision: 40 }) })] : []);
            } finally { subscription.dispose(); await runtime.dispose(); }
        });
});
