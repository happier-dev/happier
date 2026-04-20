import { describe, expect, it, vi } from 'vitest';
import type { Session } from './runtime/session/ClaudeSession';

const mockClaudeLocal = vi.fn();
const mockCreateScannerBridge = vi.fn();
const mockCreatePermissionSync = vi.fn();
const mockResolveLaunchRequest = vi.fn();
const { MockExitCodeError } = vi.hoisted(() => ({
    MockExitCodeError: class ExitCodeError extends Error {
        constructor(public readonly exitCode: number) {
            super(`ExitCodeError(${exitCode})`);
        }
    },
}));

vi.mock('./runtime/terminal/runTerminalSession', () => ({
    runClaudeTerminalSession: mockClaudeLocal,
    ExitCodeError: MockExitCodeError,
}));

vi.mock('./utils/createClaudeLocalSessionScannerBridge', () => ({
    createClaudeLocalSessionScannerBridge: mockCreateScannerBridge,
}));

vi.mock('./utils/createClaudeLocalPermissionModeMetadataSync', () => ({
    createClaudeLocalPermissionModeMetadataSync: mockCreatePermissionSync,
}));

vi.mock('./utils/resolveClaudeLocalLaunchRequest', () => ({
    resolveClaudeLocalLaunchRequest: mockResolveLaunchRequest,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

function createSessionStub(): Session {
    const session = {
        path: '/tmp',
        sessionId: null,
        transcriptPath: null,
        claudeArgs: undefined,
        defaultSystemPromptText: 'prompt',
        hookSettingsPath: '/tmp/hooks.json',
        lastPermissionModeUpdatedAt: 0,
        onThinkingChange: vi.fn(),
        noteUserAbortRequested: vi.fn(),
        adoptLastPermissionModeFromMetadata: vi.fn(),
        setLastPermissionMode: vi.fn(),
        clearSessionId: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        setAbortCurrentTurnHandler: vi.fn(),
        client: {
            sessionId: 'session-1',
            getMetadataSnapshot: vi.fn(() => null),
            sendClaudeSessionMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        },
        queue: {
            reset: vi.fn(),
            setOnMessage: vi.fn(),
        },
    };

    return session as unknown as Session;
}

describe('createClaudeLocalLaunchController', () => {
    it('detaches metadata sync and cleans up the scanner when local launch exits via ExitCodeError', async () => {
        const session = createSessionStub();
        const detach = vi.fn();
        const attach = vi.fn();
        const sync = vi.fn();
        const scannerCleanup = vi.fn(async () => {});

        mockCreateScannerBridge.mockResolvedValueOnce({
            handleSessionStart: vi.fn(),
            cleanup: scannerCleanup,
        });
        mockCreatePermissionSync.mockReturnValueOnce({
            sync,
            attach,
            detach,
        });
        mockResolveLaunchRequest.mockResolvedValueOnce({
            claudeArgs: undefined,
            envOverlay: {},
            happierMcpConfigJson: '{}',
        });
        mockClaudeLocal.mockRejectedValueOnce(new MockExitCodeError(1));

        const { createClaudeTerminalLaunchController: createClaudeLocalLaunchController } = await import('./runtime/terminal/createLaunchController');
        const controller = createClaudeLocalLaunchController({
            session,
            entry: 'initial',
            turnDiffBridge: {
                observe: vi.fn(() => null),
                reset: vi.fn(),
                flushAfterForwardIfNeeded: vi.fn(),
            },
        });

        await expect(controller.run()).resolves.toEqual({ type: 'exit', code: 1 });
        expect(detach).toHaveBeenCalledTimes(1);
        expect(scannerCleanup).toHaveBeenCalledTimes(1);
        expect(session.setAbortCurrentTurnHandler).toHaveBeenCalledWith(null);
        expect(session.client.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('switch', expect.any(Function));
    });
});
