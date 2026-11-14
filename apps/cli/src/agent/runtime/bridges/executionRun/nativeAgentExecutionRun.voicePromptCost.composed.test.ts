import { describe, expect, it, vi } from 'vitest';
import { getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';
import { createCodexAgentRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/engine.js';
import { withCodexNativeAttachFixture } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support.js';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';

// Only the external OS-user lookup and native JSON-RPC peer are substituted.
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

describe('fresh Voice carrier prompt cost', () => {
    it('omits project instructions and skill catalogs while retaining the fresh Voice function', async () => {
        const tool = getVoiceActionFunctionTool();
        const functionTools = [{ ...tool, async call() { return { ok: true }; } }];
        await withCodexNativeAttachFixture(async ({ exec, launchEnvironment, directory, requests }) => {
            const signal = new AbortController().signal;
            const runtime = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '0.0.0' },
                agent: { id: 'codex' }, signal });
            const host = createNativeAgentSessionInteractionHostRuntime({
                runtime, generationSignal: signal,
                lease: { pluginId: 'happier.agent.codex', pluginVersion: '0.0.0', agentId: 'codex', localAgentId: 'codex',
                    occurrenceId: 'voice-cost', isCurrent: () => true },
                sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
                createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({
                    services: { ...services, exec, logger: { debug() {}, info() {}, warn() {}, error() {} } }, signal, async dispose() {},
                }),
                options: { cwd: directory, runId: 'voice-cost', scope: 'session_owned', backendId: 'codex',
                    permissionMode: 'read_only', isolation: { env: launchEnvironment.values },
                    start: { intent: 'voice_agent', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
                    functionTools,
                },
            });
            try {
                const { runtimeId } = await host.provisionRuntime();
                await expect(host.deliverInput(runtimeId, { text: 'Say hello.' })).resolves.toMatchObject({ status: 'admitted' });
                const open = requests.findLast(request => request.method === 'thread/start');
                expect(open?.params.config).toMatchObject({ 'project_doc_max_bytes': 0, 'skills.include_instructions': false });
                expect(open?.params.dynamicTools).toEqual([expect.objectContaining({ name: tool.name })]);
                expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
                const dynamicTools = open?.params.dynamicTools;
                console.log(JSON.stringify({ contract: 'Codex Voice native advertisement cost',
                    fixture: 'fresh retained Voice host; Say hello input',
                    functionToolCount: Array.isArray(dynamicTools) ? dynamicTools.length : 0,
                    functionToolAdvertisementBytes: Buffer.byteLength(JSON.stringify(dynamicTools ?? []), 'utf8'),
                }));
            } finally { await host.dispose(); }
        }, { functionTools });
    });
});
