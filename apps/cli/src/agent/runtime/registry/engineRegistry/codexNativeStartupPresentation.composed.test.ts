import { describe, expect, it, vi } from 'vitest';
import { createCodexAgentRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/engine';
import { withCodexNativeAttachFixture } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { createEmptyBackendExecutionSurfaces } from '../engineRegistryTypes';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createProviderCliAttachSurface } from '@/session/attach/providerCliAttach';
import { resolveCodexAttachTarget, createCodexAttachArgs, resolveCodexAttachReachability } from '../../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/attachDescriptor';
import {
    createExternalContributionFixtures,
    createLease,
    createNativeAgentRuntimeSessionPlanFixture,
    createNativeSessionClientTestPort,
    createSessionHostServiceOwners,
} from './nativeAgentSession.composed.testkit';

// Isolate the native startup lock at its OS boundary; retain real file locking.
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

describe('Codex native startup presentation composition', () => {
    it.skipIf(process.platform === 'win32').each([
        { startedBy: 'daemon', startingMode: undefined, remote: true, exclusiveSurface: true },
        { startedBy: 'daemon', startingMode: 'remote', remote: true, exclusiveSurface: true },
        { startedBy: 'terminal', startingMode: 'remote', remote: true, exclusiveSurface: true },
        { startedBy: 'daemon', startingMode: 'terminal', remote: false, exclusiveSurface: true },
        { startedBy: 'daemon', startingMode: 'local', remote: false, exclusiveSurface: true },
        { startedBy: 'terminal', startingMode: undefined, remote: false, exclusiveSurface: true },
        { startedBy: 'daemon', startingMode: undefined, remote: true, exclusiveSurface: false },
    ] as const)(
        'admits non-owning presentation for the selected binding ($startedBy / $startingMode / exclusive=$exclusiveSurface)', async ({ startedBy, startingMode, remote, exclusiveSurface }) => {
            await withCodexNativeAttachFixture(async ({ exec, directory, requests, emitNotification }) => {
                const external = createExternalContributionFixtures('codex');
                const services = createUnavailablePluginServices();
                const generation = new AbortController();
                const runtime = await createCodexAgentRuntime({
                    plugin: { id: 'happier.agent.codex', version: '1.0.0' },
                    agent: { id: 'codex' }, signal: generation.signal,
                });
                const session = createNativeSessionClientTestPort('actual-happier-session');
                const launch = vi.fn(async () => { throw new Error('Startup must not launch an exclusive terminal'); });
                const plan = await createNativeAgentRuntimeSessionPlanFixture({
                    runtime,
                    lease: { ...createLease('codex'), pluginId: 'happier.agent.codex' },
                    backend: { ...external.backend, provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'happier.agent.codex' },
                    agent: { ...external.agent, provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'happier.agent.codex' },
                    // Preserve the loaded failing composition: an exclusive surface is
                    // available, but the opened Codex runtime prepares provider_attach.
                    executionSurfaces: exclusiveSurface
                        ? { ...createEmptyBackendExecutionSurfaces(), terminalRuntime: { launch } }
                        : { ...createEmptyBackendExecutionSurfaces(), attach: createProviderCliAttachSurface({
                            agentId: 'codex', resolveTarget: resolveCodexAttachTarget,
                            createArgs: createCodexAttachArgs, resolveReachability: resolveCodexAttachReachability,
                            resolveLaunchSpec: () => { throw new Error('Remote startup must not launch a native attach client'); },
                        }) },
                    generationSignal: generation.signal,
                    createInvocationServices: async () => ({ ...services, exec,
                        logger: { debug() {}, info() {}, warn() {}, error() {} },
                    }),
                    createSessionHostServiceOwners,
                    sessionInput: buildPluginSessionBindingInput({
                        credentials: { token: 'fixture-token', encryption: null },
                        directory, startedBy, startingMode,
                        backendTarget: { kind: 'backend', backendId: 'codex' },
                        environmentVariables: { CODEX_HOME: directory },
                    }),
                });
                const created = await plan.config.createSessionRuntime({
                    directory, metadata: {}, machineId: 'fixture-machine', session,
                    transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
                    messageQueue: new MessageQueue2<{ permissionMode: string }, { text: string }>(mode => mode.permissionMode),
                    getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
                    runWithTerminalModelSelection: async () => { throw new Error('Unexpected exclusive terminal selection'); },
                } as never);
                const assistantText: string[] = [];
                const stopEvents = created.operations.subscribeRuntimeEvents(event => {
                    if (event.kind === 'message-delta' && event.channel === 'assistant') assistantText.push(event.text);
                });
                try {
                    // Real native producer -> exact host consumer, with no fake presentation.
                    expect(await created.operations.prepareTerminalPresentation?.()).toMatchObject({
                        kind: 'provider_attach', metadata: { runtimeDescriptorV1: { agent: { providerSessionId: 'fresh-thread' } } },
                    });
                    if (exclusiveSurface) expect(created.prepareStartupPresentation).toBeTypeOf('function');
                    else {
                        expect(runtime.surfaces?.terminal).toBeUndefined();
                        expect(created.prepareStartupPresentation).toBeUndefined();
                        expect(created.terminalRemoteModeLoop?.startingMode).toBe('remote');
                    }
                    if (!remote) {
                        await expect(created.prepareStartupPresentation!()).rejects.toMatchObject({ code: 'agent_session_terminal_presentation_unsupported' });
                    } else {
                        if (exclusiveSurface) await expect(created.prepareStartupPresentation!()).resolves.toEqual({
                                terminalRemoteModeLoop: null, ownsCurrentTerminalDisplay: false,
                            });
                        // Startup acceptance is useful only if the opened native
                        // Session still admits its first remote prompt.
                        await created.operations.sendTurnPrompt('First remote reply', {
                            localId: 'first-remote-input', turnId: 'first-remote-turn', userMessageSeq: 1,
                        });
                        expect(requests).toContainEqual(expect.objectContaining({
                            method: 'turn/start', params: expect.objectContaining({
                                threadId: 'fresh-thread', input: expect.arrayContaining([
                                    expect.objectContaining({ type: 'text', text: 'First remote reply' }),
                                ]),
                            }),
                        }));
                        emitNotification('item/agentMessage/delta', {
                            threadId: 'fresh-thread', turnId: 'provider-turn-1', itemId: 'first-answer', delta: 'First remote answer',
                        });
                        emitNotification('turn/completed', {
                            threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' },
                        });
                        await created.operations.waitForTurnCompletion();
                        expect(assistantText).toContain('First remote answer');
                    }
                    expect(requests.some(request => request.method === 'thread/start')).toBe(true);
                    expect(launch).not.toHaveBeenCalled();
                } finally {
                    stopEvents();
                    await created.operations.resetOrDisposeRuntime('session_closed');
                    generation.abort();
                }
            });
        },
    );
});
