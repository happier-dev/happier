import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext, AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { createAgentLaunchObserver, runAgentSkillDeliveryContract, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createClaudeAgentRuntime } from './runtime/nativeRuntime.js';
import { createEventsFixture, createPluginContextFixture, createSessionHooksFixture, createTerminalHostFixture } from './runtime/engine.testkit.js';
import skillUsageFixture from './runtime/remote/sdk/__fixtures__/skillUsage.v1.json';

const home = mkdtempSync(join(tmpdir(), 'happier-claude-skill-native-home-'));
for (const root of ['.claude', '.agents', '.codex', '.config/opencode', '.copilot', '.gemini', '.pi', '.qwen']) {
    mkdirSync(join(home, root), { recursive: true });
    writeFileSync(join(home, root, 'retained.txt'), 'native bytes stay unchanged');
}
afterAll(() => rmSync(home, { recursive: true, force: true }));
const observer = createAgentLaunchObserver({ home });
const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
const sdkEmitters = new WeakMap<AgentSessionRuntime, (record: unknown) => void>();

async function open(request: AgentSessionOpenRequest, terminal: boolean) {
    boundaries.reset();
    let sdkEmit: ((record: unknown) => void) | undefined;
    const terminalHost = createTerminalHostFixture();
    const hooks = createSessionHooksFixture();
    const fixture = createPluginContextFixture(terminalHost.service, createEventsFixture().service, {
        sessionHooks: hooks.service, settingsValues: { claudeUnifiedTerminalEnabled: terminal },
    });
    const exited = {
        termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
        stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    };
    // Fake only the host process/JSON-stream port; nativeExec, query, launch and Session owners run unchanged.
    const exec = {
        readEnvironment: () => ({}),
        systemTools: { resolve: async () => ({ executable: { kind: 'systemTool' as const, id: 'claude-cli' }, executablePath: '/fixture/claude' }) },
        run: async () => exited,
        clients: {
            async spawn(spec: Readonly<{ launch: Readonly<{ args?: readonly string[]; env?: Readonly<Record<string, string>> }> }>) {
                boundaries.recordLaunch({ argv: spec.launch.args ?? [], env: spec.launch.env });
                const listeners = new Set<(record: unknown) => void>();
                let finish!: (value: typeof exited) => void;
                const done = new Promise<typeof exited>(resolve => { finish = resolve; });
                const emit = (record: unknown) => { for (const listener of listeners) listener(record); };
                sdkEmit = emit;
                return {
                    wait: () => done,
                    client: {
                        subscribe(listener: (record: unknown) => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
                        async write(record: unknown) {
                            if (!record || typeof record !== 'object') return;
                            if ('type' in record && record.type === 'user') {
                                queueMicrotask(() => emit({ ...record, isReplay: true, parent_tool_use_id: null }));
                            }
                            if ('type' in record && record.type === 'control_request' && 'request_id' in record) {
                                queueMicrotask(() => {
                                    emit({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: {} } });
                                    if ('request' in record && record.request && typeof record.request === 'object'
                                        && 'subtype' in record.request && record.request.subtype === 'reload_skills') {
                                        emit({ type: 'system', subtype: 'commands_changed', slash_commands: ['happier:contract-skill'] });
                                    }
                                });
                            }
                        },
                    },
                    process: { write: async () => undefined, dispose: async () => { finish(exited); } },
                    dispose: async () => { finish(exited); },
                };
            },
        },
    } as unknown as ExecService;
    const context = {
        services: { logger: fixture.logger, settings: fixture.settings, storage: fixture.storage, exec,
            interactions: { requestApproval: async () => ({ status: 'approved' }) } },
        signal: new AbortController().signal,
        session: { id: request.sessionId, services: {
            features: fixture.features, terminalHost: terminalHost.service, sessionHooks: hooks.service,
            transcripts: fixture.agentRuntime.transcripts, accountUsage: fixture.agentRuntime.accountUsage,
            toolExecution: fixture.agentRuntime.toolExecution, workflowActivity: fixture.sessions.current.workflowActivity,
            activeInput: { bind: () => ({ dispose() {} }), publishStatus: async () => undefined },
            models: { bind: () => ({ dispose() {} }) },
        } },
        workState: { publisher: () => ({ publish: async () => undefined }) },
    } as unknown as AgentSessionRuntimeContext;
    const factory = await createClaudeAgentRuntime({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'claude' }, signal: context.signal });
    if (!factory.sessions) throw new Error('Claude Session runtime missing');
    const runtime = await factory.sessions.open({ ...request, launchEnvironment: { values: { HOME: home }, unset: [] } }, context);
    runtime.watch(event => boundaries.recordRuntimeEvent(event));
    if (terminal) {
        if (!runtime.prepareTerminalPresentation) throw new Error('Claude terminal presentation missing');
        const presentation = await runtime.prepareTerminalPresentation({ modelSelection: null });
        if (presentation.kind !== 'managed_terminal') throw new Error('Expected unified terminal');
        const launch = terminalHost.service.createOrAttachHost.mock.calls.at(-1)?.[0].launch;
        boundaries.recordLaunch({ argv: launch?.args ?? [], env: launch?.env });
    } else {
        const result = await runtime.send({ inputIds: ['contract-input'], input: { text: 'Read the skill supporting file' },
            delivery: { kind: 'newTurn', turnId: 'contract-turn' } });
        if (result.status !== 'admitted') throw new Error(`Claude input ${result.status}`);
    }
    if (sdkEmit) sdkEmitters.set(runtime, sdkEmit);
    return runtime;
}

const contribution = PLUGIN_MANIFEST.contributes.agents.find(agent => agent.id === 'claude')!;
runAgentSkillDeliveryContract({
    agent: contribution,
    openSession: request => open(request, false), observeLaunch: observer.observeLaunch,
    async invokeSkill(runtime, name) {
        expect(name).toBe('contract-skill');
        const emit = sdkEmitters.get(runtime);
        if (!emit) throw new Error('SDK process boundary missing');
        emit(skillUsageFixture.assistant);
        emit(skillUsageFixture.assistant);
        emit(skillUsageFixture.toolResult);
        emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.0016,
            duration_ms: 193, duration_api_ms: 63, queued_turn_count: 0,
            session_id: skillUsageFixture.assistant.session_id, result: 'CAPTURE_OK' });
        await vi.waitFor(() => expect(observer.observeLaunch().runtimeEvents).toContainEqual(expect.objectContaining({ kind: 'skill-usage' })));
    },
    variants: [{ id: 'unified-terminal', open: request => open(request, true), expect: 'restart_required' }],
});

it('prepares SDK terminal launch skills once without treating preparation as an active terminal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-claude-sdk-terminal-skills-'));
    const skills = { pluginRoot: join(directory, 'private-plugin'), skillsRoot: join(directory, 'private-plugin', 'skills'),
        items: [{ name: 'contract-skill', skillId: 'contract:skill', digest: 'sha256:contract', directory: join(directory, 'private-plugin', 'skills', 'contract-skill') }],
        nativeDisables: [{ name: 'contract-native-blocked', path: join(home, '.claude', 'skills', 'blocked', 'SKILL.md') }] };
    mkdirSync(skills.skillsRoot, { recursive: true });
    let runtime: AgentSessionRuntime | undefined;
    try {
        runtime = await open({ kind: 'create', sessionId: 'sdk-terminal-skills', cwd: directory, skills }, false);
        if (!runtime.prepareTerminalPresentation) throw new Error('SDK terminal preparation missing');
        const presentation = await runtime.prepareTerminalPresentation({ modelSelection: null });
        expect(presentation.kind).toBe('terminal_launch');
        if (presentation.kind !== 'terminal_launch') throw new Error('Expected SDK terminal launch plan');
        const argv = presentation.plan.argv;
        expect(argv.filter(value => value === skills.pluginRoot)).toHaveLength(1);
        expect(JSON.parse(argv[argv.indexOf('--settings') + 1]).skillOverrides).toMatchObject({ 'contract-native-blocked': 'off' });
        expect(await runtime.refreshSkills?.({ skills })).toEqual({ kind: 'applied' });
        expect(observer.observeLaunch().filesWritten).toEqual([]);
    } finally {
        try { await runtime?.dispose(); }
        finally { rmSync(directory, { recursive: true, force: true }); }
    }
});
