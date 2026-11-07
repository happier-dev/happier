import { describe, expect, it, vi } from 'vitest';

import {
    createEventsFixture,
    createPluginContextFixture,
    createSdkExecFixture,
    createTerminalHostFixture,
} from '../../engine.testkit.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';
import { createClaudeAgentRuntime, createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import type { AgentExecutionRunEvent, AgentExecutionRunRuntimeContextV1, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';

describe('Claude SDK turn failure diagnostics', () => {
    it('retains the admitted Anthropic service through a real native Execution Run failure', async () => {
        const sdk = createSdkExecFixture();
        const boundary = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service);
        // Genuine capsule boundary: only native process/system-tool ports are faked, not the opener or event codecs.
        const exec = {
            systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'claude-cli' }, executablePath: '/managed/claude' }) },
            run: async () => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                stdout: new TextEncoder().encode('--effort <level>'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }),
            clients: { spawn: async () => {
                const handle = await sdk.service.spawnClient({ launch: { kind: 'agent-cli', agentId: 'claude' },
                    transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } }, protocol: { kind: 'json-stream' } });
                const wait = async () => {
                    const result = await handle.process.exit;
                    return { termination: { observed: { kind: 'exit' as const, exitCode: result.exitCode ?? 0 }, requestedBy: { kind: 'none' as const } },
                        stdout: new TextEncoder().encode(result.stdout), stderr: new TextEncoder().encode(result.stderr), stdoutTruncated: false, stderrTruncated: false };
                };
                return { client: { async write(value) { await handle.client.writeRecord(value); },
                    subscribe(listener) { return { dispose: handle.client.subscribe(listener) }; }, dispose: () => handle.dispose() },
                    process: { write: data => handle.process.writeStdin(data), closeStdin: async () => {}, async waitForExit() { return (await this.wait()).termination; },
                    wait,
                        onOutput: () => ({ dispose() {} }), dispose: () => handle.dispose() }, wait, dispose: () => handle.dispose(),
                } satisfies PluginProtocolClientHandle<'jsonStream'>;
            } },
        } as unknown as ExecService;
        const context = {
            services: { exec, logger: boundary.logger, settings: boundary.settings, storage: boundary.storage },
            signal: new AbortController().signal,
            executionRun: { id: 'source-qualified-run', services: {} },
        } as unknown as AgentExecutionRunRuntimeContextV1;
        const runtime = await createClaudeAgentRuntime({ plugin: { id: 'happier.agent.claude', version: '0.0.0' }, agent: { id: 'claude' }, signal: context.signal });
        const open = runtime.sessions?.executionRunContextV1?.open;
        if (!open) throw new Error('Native Claude Run factory is unavailable');
        const execution = await open({ kind: 'create', runId: 'source-qualified-run', cwd: '/tmp/claude-diagnostics',
            profile: { pluginId: 'happier.agent.claude', localId: 'default' }, input: { text: 'prompt' }, localInputId: 'input-run',
            launchEnvironment: { values: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
                { kind: 'profile', serviceId: 'happier.agent.claude/anthropic', profileId: 'admitted-launch-member', credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
            ]) }, unset: [] },
        }, context);
        const events: AgentExecutionRunEvent[] = [];
        execution.watch(event => events.push(event));
        try {
            await vi.waitFor(() => expect(sdk.spawnClient).toHaveBeenCalledOnce());
            await sdk.emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
                session_id: 'native-run', apiErrorStatus: 429, error: 'rate_limit_error', retry_after_ms: 1500, errors: ['Provider failed'] });
            await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'run-failed',
                diagnostic: expect.objectContaining({ details: expect.objectContaining({ runtimeAuthClassification: expect.objectContaining({
                    serviceId: 'happier.agent.claude/anthropic', profileId: null, groupId: null, kind: 'rate_limit', retryAfterMs: 1500,
                }) }) }),
            })));
            expect(events.every(event => event.runId === 'source-qualified-run' && !('sessionId' in event))).toBe(true);
        } finally { await execution.dispose(); }
    });

    it.each([
        { category: 'capacity', status: 529, error: 'overloaded_error', quotaScope: 'provider', serviceId: 'happier.agent.claude/claude-subscription' },
        { category: 'rate_limit', status: 429, error: 'rate_limit_error', quotaScope: 'account', serviceId: 'happier.agent.claude/claude-subscription' },
        { category: 'capacity', status: 529, error: 'overloaded_error', quotaScope: 'provider', serviceId: 'happier.agent.claude/anthropic' },
        { category: 'rate_limit', status: 429, error: 'rate_limit_error', quotaScope: 'account', serviceId: 'happier.agent.claude/anthropic' },
    ] as const)('retains sanitized $category evidence for $serviceId through the SDK and native runtime', async ({ category, status, error, quotaScope, serviceId }) => {
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
        const launchEnv = { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
            { kind: 'profile', serviceId, profileId: 'admitted-launch-member', credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
        ]) };
        const operations = createClaudeAgentSdkTurnOperations({
            ctx, directory: '/tmp/claude-diagnostics', launchEnv,
            happierSessionId: 'diagnostic-session', permissionMode: 'default',
        });
        // External host services are the boundary; both SDK and native event owners remain real.
        const context = {
            services: { exec: exec.service },
            session: { services: { activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) } } },
        } as unknown as AgentSessionRuntimeContext;
        const native = createClaudeNativeSessionRuntimeFromOperations(operations,
            { kind: 'create', sessionId: 'diagnostic-session', cwd: '/tmp/claude-diagnostics',
                launchEnvironment: { values: launchEnv, unset: [] } }, context);
        const events: AgentSessionRuntimeEvent[] = [];
        native.watch(event => events.push(event));
        try {
            await native.send({ inputIds: ['input-limit'], input: { text: 'prompt' }, delivery: { kind: 'newTurn', turnId: 'host-limit-turn' } });
            await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
            await exec.emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
                session_id: 'native-diagnostic', apiErrorStatus: status, error, retry_after_ms: 1500,
                errors: ['Provider failed'], privateRawField: 'PRIVATE_PROVIDER_FIELD' });
            await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
                kind: 'turn-failed', turnId: 'host-limit-turn', diagnostic: expect.objectContaining({
                    details: expect.objectContaining({
                        runtimeAuthClassification: expect.objectContaining({
                            kind: category, limitCategory: category, quotaScope, retryAfterMs: 1500,
                            serviceId, profileId: null, groupId: null,
                            source: 'structured_provider_error',
                        }),
                        usageLimit: expect.objectContaining({
                            limitCategory: category, quotaScope, retryAfterMs: 1500,
                        }),
                    }),
                }),
            })));
            expect(JSON.stringify(events)).not.toContain('PRIVATE_PROVIDER_FIELD');
        } finally { await native.dispose('session_closed'); }
    });
    it.each(['result', 'provider', 'exit', 'unknown-provider', 'unknown-result', 'signal'] as const)('logs the %s cause without provider text or credentials', async (ending) => {
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            exec: exec.service,
        });
        const operations = createClaudeAgentSdkTurnOperations({
            ctx, directory: '/tmp/claude-diagnostics', launchEnv: {},
            happierSessionId: 'diagnostic-session', permissionMode: 'default',
        });
        const privateText = 'private prompt and provider response';
        const secret = 'synthetic-credential-do-not-log';
        try {
            operations.beginProviderTurn('diagnostic-turn');
            await operations.sendProviderTurnPrompt(privateText);
            await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
            const failed = expect(operations.waitForProviderTurnCompletion()).rejects.toThrow();
            const exited = ending === 'exit' || ending === 'signal';
            if (exited) {
                await exec.exitWith({ exitCode: ending === 'exit' ? 1 : null, signal: ending === 'signal' ? 'SIGTERM' : null,
                    stderr: `${ending === 'exit' ? 'No conversation found with session ID: private-native-id\n' : ''}${privateText}\nANTHROPIC_AUTH_TOKEN=${secret}` });
            } else if (ending === 'provider' || ending === 'unknown-provider') {
                await exec.emit({ type: 'assistant', error: ending === 'provider' ? 'authentication_failed' : `${privateText} ${secret}`, isApiErrorMessage: true,
                    message: { role: 'assistant', content: [{ type: 'text', text: `${privateText} ${secret}` }] } });
            } else {
                await exec.emit({ type: 'result', subtype: ending === 'result' ? 'error_during_execution' : `${privateText} ${secret}`, is_error: true,
                    session_id: 'native-diagnostic', result: `${privateText} ${secret}` });
            }
            await failed;
            expect(ctx.logger.warn).toHaveBeenCalledWith('[ClaudeAgentSdk] Turn failed', expect.objectContaining({
                sessionId: 'diagnostic-session', turnId: 'diagnostic-turn',
                code: exited ? 'claude_sdk_stream_error'
                    : ending === 'provider' ? 'claude_authentication_failed'
                        : ending === 'result' ? 'claude_error_during_execution' : 'Unrecognized failure code (details redacted)',
                sdkResultSubtype: ending === 'result' ? 'error_during_execution'
                    : ending === 'unknown-result' ? 'Unrecognized result subtype (details redacted)' : null,
                processExitObserved: exited,
                exitCode: ending === 'exit' ? 1 : null, signal: ending === 'signal' ? 'SIGTERM' : null,
                stderrSummary: ending === 'exit' ? 'Native resume state not found (details redacted)'
                    : ending === 'signal' ? 'Native stderr present (details redacted)' : null,
            }));
            const logs = JSON.stringify(vi.mocked(ctx.logger.warn).mock.calls);
            expect(logs).not.toContain(privateText);
            expect(logs).not.toContain(secret);
            expect(logs).not.toContain(secret.replaceAll('-', '_'));
            expect(logs).not.toContain('private-native-id');
        } finally {
            await operations.disposeProviderSession();
        }
    });

    it.each(['success', 'cancelled'] as const)('does not label a %s turn as failed', async (ending) => {
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            exec: exec.service,
        });
        const operations = createClaudeAgentSdkTurnOperations({
            ctx, directory: '/tmp/claude-diagnostics', launchEnv: {},
            happierSessionId: 'diagnostic-session', permissionMode: 'default',
        });
        try {
            operations.beginProviderTurn('diagnostic-turn');
            await operations.sendProviderTurnPrompt('private prompt');
            await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
            if (ending === 'cancelled') {
                await operations.cancelProviderTurn();
            } else {
                await exec.emit({ type: 'result', subtype: 'success', is_error: false,
                    session_id: 'native-diagnostic', result: 'private response', num_turns: 1,
                    total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1 });
            }
            await operations.waitForProviderTurnCompletion();
            await operations.disposeProviderSession();
            expect(ctx.logger.warn).not.toHaveBeenCalledWith('[ClaudeAgentSdk] Turn failed', expect.anything());
        } finally {
            await operations.disposeProviderSession();
        }
    });
});
