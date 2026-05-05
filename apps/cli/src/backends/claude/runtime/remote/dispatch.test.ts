import { describe, expect, it, vi } from 'vitest';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import type { RunClaudeRemoteAgentSdkOptions } from '@/backends/claude/remote/sdk/runAgentSdkTypes';

import { dispatchClaudeRemoteSession } from './dispatch';

type DispatchOptions = Parameters<typeof dispatchClaudeRemoteSession>[0];

const remoteMode: EnhancedMode = {
    permissionMode: 'default',
    claudeRemoteAgentSdkEnabled: true,
};

function createDispatchOptions(overrides: Partial<DispatchOptions>): DispatchOptions {
    return {
        sessionId: 'sess_1',
        transcriptPath: null,
        path: '/tmp/happier',
        canCallTool: async () => {
            throw new Error('canCallTool should not run in dispatch test');
        },
        nextMessage: async () => null,
        onReady: () => undefined,
        isAborted: () => false,
        onSessionFound: () => undefined,
        onMessage: () => undefined,
        ...overrides,
    };
}

type MockRunClaudeRemoteAgentSdk = (opts: RunClaudeRemoteAgentSdkOptions) => Promise<void>;

describe('dispatchClaudeRemoteSession', () => {
    it('retries Agent SDK without resumeSessionAt when Claude rejects the matching message anchor', async () => {
        const seenPrompts: string[] = [];
        const capturedResumeAnchors: Array<unknown> = [];
        const rejectedAnchors: string[] = [];
        const mockAgentSdk: MockRunClaudeRemoteAgentSdk = vi
            .fn()
            .mockImplementationOnce(async (params) => {
                capturedResumeAnchors.push(params.resumeSessionAt);
                const next = await params.nextMessage();
                if (!next) throw new Error('expected queued message');
                seenPrompts.push(next.message);
                throw new Error(
                    'Claude Code returned an error result: No message found with message.uuid of: 84a6076b-82b1-4450-b584-ddbb2142472f',
                );
            })
            .mockImplementationOnce(async (params) => {
                capturedResumeAnchors.push(params.resumeSessionAt);
                const next = await params.nextMessage();
                if (!next) throw new Error('expected queued message');
                seenPrompts.push(next.message);
            });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await dispatchClaudeRemoteSession(
            createDispatchOptions({
                resumeSessionAt: '84a6076b-82b1-4450-b584-ddbb2142472f',
                onResumeSessionAtRejected: (anchor: string) => {
                    rejectedAnchors.push(anchor);
                },
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'continue from phone',
                        mode: remoteMode,
                    };
                },
            }),
            { runClaudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenNthCalledWith(1, 'agentSdk');
        expect(onRunnerSelected).toHaveBeenNthCalledWith(2, 'agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(2);
        expect(capturedResumeAnchors).toEqual([
            '84a6076b-82b1-4450-b584-ddbb2142472f',
            null,
        ]);
        expect(seenPrompts).toEqual(['continue from phone', 'continue from phone']);
        expect(rejectedAnchors).toEqual(['84a6076b-82b1-4450-b584-ddbb2142472f']);
    });

    it('does not retry without resumeSessionAt when Claude rejects a different message anchor', async () => {
        const mockAgentSdk: MockRunClaudeRemoteAgentSdk = vi.fn(async (params) => {
            await params.nextMessage();
            throw new Error(
                'Claude Code returned an error result: No message found with message.uuid of: 00000000-0000-4000-8000-000000000000',
            );
        });
        const onResumeSessionAtRejected = vi.fn();

        let sent = false;
        await expect(
            dispatchClaudeRemoteSession(
                createDispatchOptions({
                    resumeSessionAt: '84a6076b-82b1-4450-b584-ddbb2142472f',
                    onResumeSessionAtRejected,
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return {
                            message: 'continue from phone',
                            mode: remoteMode,
                        };
                    },
                }),
                { runClaudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/No message found with message\.uuid/);

        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(onResumeSessionAtRejected).not.toHaveBeenCalled();
    });
});
