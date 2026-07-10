import type { TerminalRuntimeProjectionHostServiceV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

type ProjectionModule = typeof import('./projection.js');

async function loadProjectionModule(): Promise<ProjectionModule> {
    const module = await import('./projection.js').catch(() => null);
    expect(module).toEqual(expect.objectContaining({
        CODEX_TERMINAL_PROVIDER_SESSION_METADATA_KEY: 'codexSessionId',
        createCodexTerminalRuntimeProjection: expect.any(Function),
    }));
    if (!module) {
        throw new Error('Codex terminal projection module is not available');
    }
    return module;
}

function createProjectionFixture() {
    const handle = Object.freeze({ stop: vi.fn() });
    const projection = {
        openDirectTranscriptMirror: vi.fn(async () => handle),
        publishControlState: vi.fn(),
        publishProviderSessionId: vi.fn(async () => true),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
    } satisfies TerminalRuntimeProjectionHostServiceV1;
    return { projection, handle };
}

describe('createCodexTerminalRuntimeProjection', () => {
    it('publishes Codex session ids through provider-neutral identity projection', async () => {
        const { createCodexTerminalRuntimeProjection } = await loadProjectionModule();
        const { projection } = createProjectionFixture();
        const codexProjection = createCodexTerminalRuntimeProjection({ projection });

        await expect(codexProjection.publishCodexSessionId(' codex-session-1 ')).resolves.toBe(true);

        expect(projection.publishProviderSessionId).toHaveBeenCalledWith({
            providerSessionId: 'codex-session-1',
            metadataKey: 'codexSessionId',
        });
    });

    it('ignores blank Codex session ids', async () => {
        const { createCodexTerminalRuntimeProjection } = await loadProjectionModule();
        const { projection } = createProjectionFixture();
        const codexProjection = createCodexTerminalRuntimeProjection({ projection });

        await expect(codexProjection.publishCodexSessionId('   ')).resolves.toBe(false);

        expect(projection.publishProviderSessionId).not.toHaveBeenCalled();
    });

    it('publishes Codex terminal control state through provider-neutral control projection', async () => {
        const { createCodexTerminalRuntimeProjection } = await loadProjectionModule();
        const { projection } = createProjectionFixture();
        const codexProjection = createCodexTerminalRuntimeProjection({ projection });

        await codexProjection.publishControlState({ target: 'local', reason: 'terminal_started' });

        expect(projection.publishControlState).toHaveBeenCalledWith({
            target: 'local',
            reason: 'terminal_started',
        });
    });

    it('opens Codex direct transcript mirrors through provider-neutral mirror projection', async () => {
        const { createCodexTerminalRuntimeProjection } = await loadProjectionModule();
        const { projection, handle } = createProjectionFixture();
        const codexProjection = createCodexTerminalRuntimeProjection({ projection });
        const request = Object.freeze({
            binding: Object.freeze({
                providerId: 'codex',
                source: Object.freeze({ kind: 'codexHome', home: 'user' }),
                remoteSessionId: 'codex-session-1',
            }),
            onItems: vi.fn(),
        });

        await expect(codexProjection.openDirectTranscriptMirror(request)).resolves.toBe(handle);

        expect(projection.openDirectTranscriptMirror).toHaveBeenCalledWith(request);
    });

    it('publishes Codex native subagent starts through provider-neutral subagent projection', async () => {
        const { createCodexTerminalRuntimeProjection } = await loadProjectionModule();
        const { projection } = createProjectionFixture();
        const codexProjection = createCodexTerminalRuntimeProjection({ projection });

        await codexProjection.publishSubagentStarted({
            threadId: 'thread-1',
            prompt: 'review patch',
            nickname: 'Review',
            role: 'critic',
        });

        expect(projection.publishSubagentStarted).toHaveBeenCalledWith({
            providerId: 'codex',
            agentKind: 'codex-native-subagent',
            subagentId: 'thread-1',
            sidechainId: 'thread-1',
            label: 'Review',
            role: 'critic',
            metadata: {
                threadId: 'thread-1',
                prompt: 'review patch',
                nickname: 'Review',
                role: 'critic',
            },
        });
    });

    it('publishes Codex native subagent completions through provider-neutral subagent projection', async () => {
        const { createCodexTerminalRuntimeProjection } = await loadProjectionModule();
        const { projection } = createProjectionFixture();
        const codexProjection = createCodexTerminalRuntimeProjection({ projection });

        await codexProjection.publishSubagentCompleted({
            threadId: 'thread-1',
            status: 'interrupted',
            summaryText: 'Stopped by user',
        });

        expect(projection.publishSubagentCompleted).toHaveBeenCalledWith({
            providerId: 'codex',
            agentKind: 'codex-native-subagent',
            subagentId: 'thread-1',
            sidechainId: 'thread-1',
            status: 'aborted',
            lifecycleDetail: {
                agentState: 'interrupted',
                reason: 'provider_interrupted',
                summaryText: 'Stopped by user',
            },
            metadata: {
                threadId: 'thread-1',
            },
        });
    });
});
