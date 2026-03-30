import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import type { SystemTaskEvent, SystemTaskSpec } from '@happier-dev/protocol';

const capturedSpecs = vi.hoisted(() => [] as SystemTaskSpec[]);

const promptSnapshot = vi.hoisted(() => ({
    taskId: 'ssh-task-1',
    status: 'running',
    currentStepId: 'ssh.auth.request',
    latestMessage: 'Approve remote machine pairing',
    awaitingInput: true,
    cancelRequested: false,
    events: [
        {
            protocolVersion: 1,
            taskId: 'ssh-task-1',
            tsMs: 1,
            type: 'prompt',
            message: 'Approve remote machine pairing',
            data: {
                kind: 'auth.approveRemoteProvisioning',
                message: 'Approve remote machine pairing',
                publicKey: null,
            },
        },
    ] as readonly SystemTaskEvent[],
    result: null,
}) satisfies SystemTaskRunState);

describe('useRemoteSshBootstrapTask', () => {
    it('does not auto-approve remote provisioning when the prompt omits a public key', async () => {
        capturedSpecs.length = 0;
        const runner: SystemTaskRunner = {
            mode: 'tauri',
            start: async (spec) => {
                capturedSpecs.push(spec);
                return `ssh-task-${capturedSpecs.length}`;
            },
            cancel: async () => undefined,
            respond: async () => undefined,
            getSnapshot: () => promptSnapshot,
            subscribe: () => () => undefined,
        };

        const { useRemoteSshBootstrapTask } = await import('./useRemoteSshBootstrapTask');
        const hook = await renderHook(() => useRemoteSshBootstrapTask({
            runner,
            relayUrl: 'https://relay.example.test',
        }), { flushOptions: { cycles: 0 } });

        await act(async () => {
            await hook.getCurrent().start({
                sshTarget: 'dev@example.test',
                sshAuth: 'agent',
                identityFilePath: '',
                installRelayRuntime: false,
            });
        });
        await hook.rerender();

        expect(hook.getCurrent().activeTaskSnapshot?.currentStepId).toBe('ssh.auth.request');

        const currentPrompt = hook.getCurrent().prompt;
        expect(currentPrompt?.kind).toBe('auth.approveRemoteProvisioning');
        if (currentPrompt?.kind === 'auth.approveRemoteProvisioning') {
            expect(currentPrompt.publicKey).toBeNull();
        }

        await act(async () => {
            await hook.getCurrent().continueAfterPrompt({
                sshTarget: 'dev@example.test',
                sshAuth: 'agent',
                identityFilePath: '',
                installRelayRuntime: false,
            });
        });

        expect(capturedSpecs).toHaveLength(2);
        expect(capturedSpecs[1]?.params).not.toHaveProperty('promptResolution');
    });
});
