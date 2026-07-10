import type { AgentState, Metadata } from '@/api/types';
import { createHostSubagentStore } from '@/session/subagents/hostSubagentStore';
import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';
import { describe, expect, it, vi } from 'vitest';

async function loadProjectionModule() {
    const module = await import('./projection').catch(() => null);
    expect(module).toEqual(expect.objectContaining({
        createTerminalRuntimeProjectionHostService: expect.any(Function),
    }));
    if (!module) {
        throw new Error('terminal projection module is not available');
    }
    return module;
}

function createMetadataFixture(): Metadata {
    return {
        path: '/repo',
        host: 'host.local',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happier',
        happyLibDir: '/home/user/.happier/lib',
        happyToolsDir: '/home/user/.happier/tools',
    };
}

function createSessionFixture() {
    let metadata: Metadata = createMetadataFixture();
    let agentState: AgentState = {};
    const events: unknown[] = [];
    return {
        session: {
            sessionId: 'terminal-parent-session',
            sendSessionEvent(event: SessionEventMessage) {
                events.push(event);
            },
            updateMetadata(updater: (current: Metadata) => Metadata) {
                metadata = updater(metadata);
            },
            updateAgentState(updater: (current: AgentState) => AgentState) {
                agentState = updater(agentState);
            },
        },
        readMetadata: () => metadata,
        readAgentState: () => agentState,
        readEvents: () => [...events],
    };
}

describe('createTerminalRuntimeProjectionHostService', () => {
    it('opens direct transcript mirrors through the transcript host service', async () => {
        const { createTerminalRuntimeProjectionHostService } = await loadProjectionModule();
        const fixture = createSessionFixture();
        const handle = Object.freeze({ stop: vi.fn() });
        const transcripts = Object.freeze({
            openDirectMirror: vi.fn(async () => handle),
        });

        const service = createTerminalRuntimeProjectionHostService({
            session: fixture.session,
            transcripts,
            subagents: createHostSubagentStore(),
        });
        const request = Object.freeze({
            binding: Object.freeze({
                agentId: 'codex',
                source: Object.freeze({ kind: 'codexHome', home: 'user' }),
                remoteSessionId: 'codex-session-1',
            }),
            onItems: vi.fn(),
        });

        await expect(service.openDirectTranscriptMirror(request)).resolves.toBe(handle);

        expect(transcripts.openDirectMirror).toHaveBeenCalledWith(request);
        expect(Object.keys(service).sort()).toEqual([
            'openDirectTranscriptMirror',
            'publishControlState',
            'publishProviderSessionId',
            'publishSubagentCompleted',
            'publishSubagentStarted',
        ]);
        expect(service).not.toHaveProperty('session');
        expect(service).not.toHaveProperty('subagents');
        expect(service).not.toHaveProperty('transcripts');
    });

    it('publishes provider session identity through session metadata', async () => {
        const { createTerminalRuntimeProjectionHostService } = await loadProjectionModule();
        const fixture = createSessionFixture();
        const service = createTerminalRuntimeProjectionHostService({
            session: fixture.session,
            transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
            subagents: createHostSubagentStore(),
        });

        await expect(service.publishProviderSessionId({
            providerSessionId: 'provider-session-1',
            metadataKey: 'codexSessionId',
        })).resolves.toBe(true);

        expect(fixture.readMetadata()).toMatchObject({
            codexSessionId: 'provider-session-1',
        });
    });

    it('publishes terminal switch events for control state', async () => {
        const { createTerminalRuntimeProjectionHostService } = await loadProjectionModule();
        const fixture = createSessionFixture();
        const service = createTerminalRuntimeProjectionHostService({
            session: fixture.session,
            transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
            subagents: createHostSubagentStore(),
        });

        await service.publishControlState({ target: 'local', reason: 'terminal_started' });

        expect(fixture.readEvents()).toEqual([
            { type: 'switch', mode: 'local' },
        ]);
    });

    it('updates controlledByUser for control state', async () => {
        const { createTerminalRuntimeProjectionHostService } = await loadProjectionModule();
        const fixture = createSessionFixture();
        const service = createTerminalRuntimeProjectionHostService({
            session: fixture.session,
            transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
            subagents: createHostSubagentStore(),
        });

        await service.publishControlState({ target: 'remote', reason: 'terminal_released' });

        expect(fixture.readAgentState()).toMatchObject({
            controlledByUser: false,
        });
    });

    it('publishes running subagents through the host subagent store', async () => {
        const { createTerminalRuntimeProjectionHostService } = await loadProjectionModule();
        const fixture = createSessionFixture();
        const subagents = createHostSubagentStore();
        const service = createTerminalRuntimeProjectionHostService({
            session: fixture.session,
            transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
            subagents,
        });

        await service.publishSubagentStarted({
            agentId: 'acme-terminal',
            agentKind: 'acme-native-subagent',
            subagentId: 'thread-1',
            label: 'Review worker',
            metadata: { prompt: 'Review the patch' },
        });

        await expect(subagents.get({
            parentSessionId: 'terminal-parent-session',
            id: 'thread-1',
        })).resolves.toEqual(expect.objectContaining({
            id: 'thread-1',
            parentSessionId: 'terminal-parent-session',
            origin: 'agent',
            kind: 'native',
            status: 'running',
            agentRef: {
                agentId: 'acme-terminal',
                agentKind: 'acme-native-subagent',
            },
            transcript: {
                parentSessionId: 'terminal-parent-session',
                sidechainId: 'thread-1',
            },
            label: 'Review worker',
            agentMetadata: {
                prompt: 'Review the patch',
            },
        }));
    });

    it('publishes completed subagents through the host subagent store', async () => {
        const { createTerminalRuntimeProjectionHostService } = await loadProjectionModule();
        const fixture = createSessionFixture();
        const subagents = createHostSubagentStore();
        const service = createTerminalRuntimeProjectionHostService({
            session: fixture.session,
            transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
            subagents,
        });

        await service.publishSubagentCompleted({
            agentId: 'codex',
            agentKind: 'codex-native-subagent',
            subagentId: 'thread-1',
            lifecycleDetail: { agentState: 'completed' },
        });

        await expect(subagents.get({
            parentSessionId: 'terminal-parent-session',
            id: 'thread-1',
        })).resolves.toEqual(expect.objectContaining({
            id: 'thread-1',
            status: 'completed',
            lifecycleDetail: { agentState: 'completed' },
        }));
    });

    it('preserves existing subagent details when publishing completion', async () => {
        const { createTerminalRuntimeProjectionHostService } = await loadProjectionModule();
        const fixture = createSessionFixture();
        const subagents = createHostSubagentStore();
        const service = createTerminalRuntimeProjectionHostService({
            session: fixture.session,
            transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
            subagents,
        });

        await service.publishSubagentStarted({
            agentId: 'acme-terminal',
            agentKind: 'acme-native-subagent',
            subagentId: 'thread-1',
            label: 'Review worker',
            metadata: { prompt: 'Review the patch' },
        });
        await service.publishSubagentCompleted({
            subagentId: 'thread-1',
            lifecycleDetail: { agentState: 'completed' },
        });

        await expect(subagents.get({
            parentSessionId: 'terminal-parent-session',
            id: 'thread-1',
        })).resolves.toEqual(expect.objectContaining({
            id: 'thread-1',
            status: 'completed',
            label: 'Review worker',
            display: { label: 'Review worker' },
            agentMetadata: {
                prompt: 'Review the patch',
            },
            lifecycleDetail: { agentState: 'completed' },
        }));
    });
});
