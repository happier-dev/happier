import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import type { SystemTaskEvent, SystemTaskResult } from '@happier-dev/protocol';

import type { SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';
import type { SystemTaskRunState, SystemTaskRunner } from '../types';

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn(async () => false),
    prompt: vi.fn(async () => null as string | null),
}));

// Mock factories import the leaf testkit mock modules, never the full
// `@/dev/testkit` barrel: awaiting the barrel inside a factory can deadlock
// module evaluation (the barrel itself imports product modules), leaving the
// runner hung with no tests collected.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: modalSpies.confirm,
            prompt: modalSpies.prompt,
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

function createRunnerStub() {
    const respond = vi.fn(async (_taskId: string, _answer: unknown) => {});
    const cancel = vi.fn(async (_taskId: string) => {});
    const runner: SystemTaskRunner = {
        mode: 'dev',
        start: async () => 'task-1',
        cancel,
        respond,
        getSnapshot: () => null,
        subscribe(
            _taskId: string,
            _listenerOrOnEvent?: (() => void) | ((event: SystemTaskEvent) => void),
            _onResult?: (result: SystemTaskResult) => void,
        ) {
            return () => {};
        },
    };
    return { runner, respond, cancel };
}

function createSnapshot(taskId: string): SystemTaskRunState {
    return {
        taskId,
        status: 'running',
        currentStepId: 'ssh.auth',
        latestMessage: null,
        awaitingInput: true,
        cancelRequested: false,
        events: [],
        result: null,
    };
}

async function renderPrompt(prompt: SystemTaskPromptEnvelope) {
    const { useSshSystemTaskPromptModals } = await import('./useSshSystemTaskPromptModals');
    const taskId = 'task-1';
    const { runner, respond, cancel } = createRunnerStub();
    await renderHook(() => useSshSystemTaskPromptModals({
        runner,
        taskId,
        snapshot: createSnapshot(taskId),
        prompt,
    }));
    await flushHookEffects();
    return { taskId, respond, cancel };
}

afterEach(() => {
    standardCleanup();
    modalSpies.confirm.mockReset();
    modalSpies.confirm.mockResolvedValue(false);
    modalSpies.prompt.mockReset();
    modalSpies.prompt.mockResolvedValue(null);
});

describe('useSshSystemTaskPromptModals', () => {
    it('remembers accepted SSH host keys when the user opts into persistent trust', async () => {
        modalSpies.confirm
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);

        const { taskId, respond } = await renderPrompt({
            kind: 'ssh.trustHost',
            message: 'Trust this SSH host?',
            data: {
                kind: 'ssh.trustHost',
                promptId: 'host-key-task-1',
                host: 'server.example.test',
                fingerprint: 'SHA256:abc',
            },
        });

        expect(modalSpies.confirm).toHaveBeenCalledTimes(2);
        expect(respond).toHaveBeenCalledWith(taskId, { trusted: true, remember: true });
    });

    it('distinguishes changed SSH host keys from first-time trust prompts', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);

        const { taskId, respond } = await renderPrompt({
            kind: 'ssh.replaceHostKey',
            message: '',
            data: {
                kind: 'ssh.replaceHostKey',
                promptId: 'host-key-task-1',
                host: 'server.example.test',
                fingerprint: 'SHA256:new',
                existingFingerprint: 'SHA256:old',
            },
        });

        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'settings.remoteHostsReplaceHostKeyTitle',
            expect.stringContaining('settings.remoteHostsHostKeyCurrentFingerprintLabel: SHA256:old'),
            expect.objectContaining({
                confirmText: 'settings.remoteHostsReplaceHostKeyAction',
            }),
        );
        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'settings.remoteHostsReplaceHostKeyTitle',
            expect.stringContaining('settings.remoteHostsHostKeyNewFingerprintLabel: SHA256:new'),
            expect.any(Object),
        );
        expect(respond).toHaveBeenCalledWith(taskId, { trusted: true, remember: true });
    });

    it('submits private-key passphrases through the shared SSH prompt contract', async () => {
        modalSpies.prompt.mockResolvedValueOnce('secret phrase');

        const { taskId, respond } = await renderPrompt({
            kind: 'ssh.privateKeyPassphrase',
            message: 'untranslated-native-message',
            data: {
                kind: 'ssh.privateKeyPassphrase',
                promptId: 'auth-passphrase-task-1',
                host: 'server.example.test',
                port: 22,
                username: 'dev',
                attemptsRemaining: 3,
            },
        });

        expect(modalSpies.prompt).toHaveBeenCalledWith(
            'settings.remoteHostsPrivateKeyPassphraseTitle',
            'server.example.test',
            expect.objectContaining({ inputType: 'secure-text' }),
        );
        expect(respond).toHaveBeenCalledWith(taskId, { passphrase: 'secret phrase' });
    });

    it('submits ordered keyboard-interactive answers without changing prompt ids', async () => {
        modalSpies.prompt
            .mockResolvedValueOnce('password')
            .mockResolvedValueOnce('123456');

        const { taskId, respond } = await renderPrompt({
            kind: 'ssh.keyboardInteractive',
            message: 'Answer the SSH authentication prompt.',
            data: {
                kind: 'ssh.keyboardInteractive',
                promptId: 'auth-kbi-task-1',
                host: 'server.example.test',
                port: 22,
                username: 'dev',
                prompts: [
                    { id: '0', label: 'Password:', echo: false },
                    { id: '1', label: 'Token:', echo: true },
                ],
            },
        });

        expect(modalSpies.prompt).toHaveBeenCalledTimes(2);
        expect(respond).toHaveBeenCalledWith(taskId, {
            keyboardInteractiveAnswers: [
                { id: '0', value: 'password' },
                { id: '1', value: '123456' },
            ],
        });
    });
});
