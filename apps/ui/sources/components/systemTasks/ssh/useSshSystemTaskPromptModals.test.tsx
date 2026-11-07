import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import type { SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn(async () => false),
    prompt: vi.fn(async () => null as string | null),
    /** The host-key sheet's answers, in order; the sheet settles through its own onResolve. */
    hostKeyAnswers: [] as boolean[],
    show: vi.fn((config: { chrome?: { testID?: string }; props?: { onResolve?: (trusted: boolean) => void } }) => {
        if (config.chrome?.testID === 'ssh-host-key-modal') {
            const answer = modalSpies.hostKeyAnswers.shift() ?? false;
            queueMicrotask(() => config.props?.onResolve?.(answer));
        }
        return 'modal-id';
    }),
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
            show: modalSpies.show as never,
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

// Cold UI transformation belongs to collection, outside each prompt's lifecycle assertion.
// Keep the real sheet and its platform/modal boundaries; dispatch still uses import().
await import('./useSshSystemTaskPromptModals');
await import('@/components/ssh/SshHostKeyTrustSheet');

async function renderPrompt(prompt: SystemTaskPromptEnvelope) {
    const { useSshSystemTaskPromptModals } = await import('./useSshSystemTaskPromptModals');
    const manual = createManualSystemTaskRunner('dev');
    const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'relay.runtime.status.v1', params: {} });
    manual.emitEvent(taskId, { type: 'prompt', ...(prompt.message ? { message: prompt.message } : {}), data: { ...prompt.data, kind: prompt.kind } });
    await renderHook(() => useSshSystemTaskPromptModals({
        runner: manual.runner,
        taskId,
        snapshot: manual.runner.getSnapshot(taskId),
        prompt,
    }));
    await vi.dynamicImportSettled();
    await flushHookEffects();
    return { taskId, respond: manual.bridge.respond, cancel: manual.bridge.cancel };
}

afterEach(() => {
    standardCleanup();
    modalSpies.confirm.mockReset();
    modalSpies.confirm.mockResolvedValue(false);
    modalSpies.prompt.mockReset();
    modalSpies.prompt.mockResolvedValue(null);
    modalSpies.show.mockClear();
    modalSpies.hostKeyAnswers.length = 0;
});

describe('useSshSystemTaskPromptModals', () => {
    it('offers only trust-once when the current response Action cannot remember a host key', async () => {
        const { answerSshSystemTaskPrompt } = await import('./answerSshSystemTaskPrompt');
        modalSpies.hostKeyAnswers.push(true);
        const options = { isCurrent: () => true, cancel: async () => {}, supportsRememberHostKey: false };
        expect(await answerSshSystemTaskPrompt({ kind: 'ssh.trustHost', message: '',
            data: { host: 'worker.test', keyType: 'ssh-ed25519', fingerprint: 'SHA256:worker' } }, options)).toEqual({ trusted: true });
        // The host key is the trust sheet (lab af-ssh Kp): the full fingerprint, a sheet on phones, no second question.
        expect(modalSpies.show).toHaveBeenCalledTimes(1);
        expect(modalSpies.show.mock.calls[0]![0]).toMatchObject({
            chrome: { testID: 'ssh-host-key-modal', phonePresentation: 'sheet' },
            props: { request: { host: 'worker.test', keyType: 'ssh-ed25519', fingerprint: 'SHA256:worker' } },
        });
        expect(modalSpies.confirm).not.toHaveBeenCalled();
    });
    it('retries a failed native answer after remount while retaining the admitted continuation', async () => {
        const { useSshSystemTaskPromptModals } = await import('./useSshSystemTaskPromptModals');
        const manual = createManualSystemTaskRunner('dev');
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'relay.runtime.status.v1', params: {} });
        modalSpies.prompt.mockResolvedValue('password');
        manual.bridge.respond.mockRejectedValueOnce(new Error('Native transport disconnected'));
        manual.bridge.respond.mockImplementation(async () => {
            manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true, data: {} });
            return undefined;
        });
        const mount = () => renderHook(() => useSshSystemTaskPromptModals({
            runner: manual.runner, taskId, snapshot: manual.runner.getSnapshot(taskId), prompt: null,
        }));
        const hook = await mount();
        manual.emitEvent(taskId, { type: 'prompt', data: { kind: 'ssh.password', promptId: 'password-1' } });
        await flushHookEffects();
        await hook.unmount();
        await mount();
        expect(manual.runner.getSnapshot(taskId)?.status).toBe('succeeded');
    });

    it('preserves an admitted continuation authority check when a task surface mounts', async () => {
        const { createSshSystemTaskPromptContinuation } = await import('./answerSshSystemTaskPrompt');
        const { useSshSystemTaskPromptModals } = await import('./useSshSystemTaskPromptModals');
        const manual = createManualSystemTaskRunner('dev');
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'relay.runtime.status.v1', params: {} });
        manual.runner.registerPromptContinuation?.(taskId, createSshSystemTaskPromptContinuation(manual.runner, taskId, () => false));
        const prompt = { kind: 'ssh.password', message: '', data: { kind: 'ssh.password', promptId: 'password-1' } };
        manual.emitEvent(taskId, { type: 'prompt', data: prompt.data });
        await renderHook(() => useSshSystemTaskPromptModals({
            runner: manual.runner, taskId, snapshot: manual.runner.getSnapshot(taskId), prompt,
        }));
        expect(modalSpies.prompt).not.toHaveBeenCalled();
        expect(manual.bridge.respond).not.toHaveBeenCalled();
    });

    it('withholds a secure answer when its captured invocation authority retires during the modal', async () => {
        const { createSshSystemTaskPromptContinuation } = await import('./answerSshSystemTaskPrompt');
        const manual = createManualSystemTaskRunner('dev');
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'relay.runtime.status.v1', params: {} });
        let current = true;
        const password = createDeferred<string | null>();
        modalSpies.prompt.mockReturnValueOnce(password.promise);
        manual.runner.registerPromptContinuation?.(taskId, createSshSystemTaskPromptContinuation(manual.runner, taskId, () => current));
        manual.emitEvent(taskId, { type: 'prompt', data: { kind: 'ssh.password', promptId: 'password-1' } });
        await flushHookEffects();
        expect(modalSpies.prompt).toHaveBeenCalled();
        current = false;
        password.resolve('secret');
        await flushHookEffects();
        expect(manual.bridge.respond).not.toHaveBeenCalled();
        expect(manual.bridge.cancel).not.toHaveBeenCalled();
    });

    it('cancels native provisioning on human refusal without manufacturing approval', async () => {
        const { createSshSystemTaskPromptContinuation } = await import('./answerSshSystemTaskPrompt');
        const manual = createManualSystemTaskRunner('dev');
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'relay.runtime.status.v1', params: {} });
        manual.runner.registerPromptContinuation?.(taskId, createSshSystemTaskPromptContinuation(manual.runner, taskId));
        manual.emitEvent(taskId, { type: 'prompt', data: { kind: 'auth.approveRemoteProvisioning', promptId: 'approval-1' } });
        await flushHookEffects();
        expect(manual.bridge.cancel).toHaveBeenCalledWith(taskId);
        expect(manual.bridge.respond).not.toHaveBeenCalled();
        manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: false, error: { code: 'canceled', message: 'Canceled' } });
        expect(manual.runner.getSnapshot(taskId)?.status).toBe('canceled');
    });

    it('does not submit a late passphrase to a newer native prompt', async () => {
        const { useSshSystemTaskPromptModals } = await import('./useSshSystemTaskPromptModals');
        const manual = createManualSystemTaskRunner('dev');
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'relay.runtime.status.v1', params: {} });
        const passphrase = createDeferred<string | null>();
        modalSpies.prompt.mockReturnValueOnce(passphrase.promise).mockResolvedValueOnce('new-password');
        const prompt = { kind: 'ssh.privateKeyPassphrase', message: '', data: { kind: 'ssh.privateKeyPassphrase', promptId: 'key-1' } };
        manual.emitEvent(taskId, { type: 'prompt', data: prompt.data });
        await renderHook(() => useSshSystemTaskPromptModals({
            runner: manual.runner, taskId, snapshot: manual.runner.getSnapshot(taskId), prompt,
        }));
        manual.emitEvent(taskId, { type: 'prompt', data: { kind: 'ssh.password', promptId: 'password-2' } });
        passphrase.resolve('old-secret');
        await flushHookEffects();
        expect(manual.bridge.respond).not.toHaveBeenCalledWith(taskId, { passphrase: 'old-secret' });
    });

    it('keeps answering SSH prompts through terminal settlement after the starting view unmounts', async () => {
        const { useSshSystemTaskPromptModals } = await import('./useSshSystemTaskPromptModals');
        const manual = createManualSystemTaskRunner('dev');
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'relay.runtime.status.v1', params: {} });
        const hook = await renderHook(() => useSshSystemTaskPromptModals({
            runner: manual.runner,
            taskId,
            snapshot: manual.runner.getSnapshot(taskId),
            prompt: null,
        }));
        await hook.unmount();
        modalSpies.hostKeyAnswers.push(true);
        modalSpies.confirm.mockResolvedValueOnce(false);
        manual.emitEvent(taskId, { type: 'prompt', data: {
            kind: 'ssh.trustHost', promptId: 'trust-1', host: 'remote.test', fingerprint: 'SHA256:remote',
        } });
        await vi.dynamicImportSettled();
        await flushHookEffects();
        expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { trusted: true });
        modalSpies.prompt.mockResolvedValueOnce('password');
        manual.emitEvent(taskId, { type: 'prompt', data: { kind: 'ssh.password', promptId: 'password-1' } });
        await flushHookEffects();
        expect(manual.bridge.respond).toHaveBeenLastCalledWith(taskId, { password: 'password' });
        manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true, data: {} });
        expect(manual.runner.getSnapshot(taskId)?.status).toBe('succeeded');
        expect(manual.runner.listPromptContinuations?.()).toEqual([]);
    });

    it('keeps remote service replacement and release-channel switching as separate prompt answers', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const servicePrompt = await renderPrompt({
            kind: 'daemon.replaceRemoteBackgroundServices',
            message: 'Replace existing services?',
            data: { targetReleaseChannel: 'preview', targetServerUrl: null, services: [] },
        });
        // The title is app copy, not the daemon's English prompt sentence.
        expect(modalSpies.confirm).toHaveBeenLastCalledWith(
            'machine.backgroundServicePrompt.replaceTitle',
            undefined,
            expect.objectContaining({ confirmText: 'settings.machineSetupRemotePromptReplaceServicesAction' }),
        );
        expect(servicePrompt.respond).toHaveBeenCalledWith(servicePrompt.taskId, { replaceExistingServices: true });

        modalSpies.confirm.mockResolvedValueOnce(false);
        const channelPrompt = await renderPrompt({
            kind: 'releaseChannel.switchDefaultForSetup',
            message: 'Switch the default release channel?',
            data: {
                targetReleaseChannel: 'preview',
                currentDefaultReleaseChannel: 'stable',
                targetServerUrl: null,
                managedReleaseChannels: [],
            },
        });
        expect(channelPrompt.respond).toHaveBeenCalledWith(channelPrompt.taskId, { switchDefaultReleaseChannel: false });
    });

    it('shows exact inspected Personal Home erase facts and forwards the destructive decision', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);

        const { taskId, respond } = await renderPrompt({
            kind: 'personal_home.confirm_remote_erase.v1',
            message: 'Erase this remote Personal Home?',
            data: {
                promptId: 'erase-task-1',
                sshHost: 'home-admin@example.test',
                canonicalServerUrl: 'https://home.example.test',
                homeServerIdentityId: 'home_1',
                paths: ['/srv/happier/home.db', '/srv/happier/uploads'],
                estimatedBytes: 4096,
            },
        });

        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'Erase this remote Personal Home?',
            expect.stringContaining('home-admin@example.test'),
            expect.any(Object),
        );
        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'Erase this remote Personal Home?',
            expect.stringContaining('/srv/happier/home.db'),
            expect.objectContaining({ destructive: true }),
        );
        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'Erase this remote Personal Home?',
            expect.stringContaining('home_1'),
            expect.any(Object),
        );
        expect(respond).toHaveBeenCalledWith(taskId, { confirmed: true });
    });

    it('declines remote Personal Home erase without cancelling the transport task', async () => {
        modalSpies.confirm.mockResolvedValueOnce(false);
        const { taskId, respond, cancel } = await renderPrompt({
            kind: 'personal_home.confirm_remote_erase.v1',
            message: 'Erase this remote Personal Home?',
            data: {
                sshHost: 'home-admin@example.test',
                canonicalServerUrl: 'https://home.example.test',
                homeServerIdentityId: 'home_1',
                paths: ['/srv/happier/home.db'],
                estimatedBytes: null,
            },
        });

        expect(respond).toHaveBeenCalledWith(taskId, { confirmed: false });
        expect(cancel).not.toHaveBeenCalled();
    });

    it('fails a remote Personal Home ownership prompt without an exact SSH host closed', async () => {
        const { taskId, respond } = await renderPrompt({
            kind: 'personal_home.confirm_remote_erase.v1',
            message: 'Erase this remote Personal Home?',
            data: {
                canonicalServerUrl: 'https://home.example.test',
                homeServerIdentityId: 'home_1',
                paths: ['/srv/happier/home.db'],
                estimatedBytes: 1,
            },
        });

        expect(modalSpies.confirm).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(taskId, { confirmed: false });
    });

    it('remembers accepted SSH host keys when the user opts into persistent trust', async () => {
        modalSpies.hostKeyAnswers.push(true);
        modalSpies.confirm.mockResolvedValueOnce(true);

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

        expect(modalSpies.show).toHaveBeenCalledTimes(1);
        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(respond).toHaveBeenCalledWith(taskId, { trusted: true, remember: true });
    });

    it('distinguishes changed SSH host keys from first-time trust prompts', async () => {
        modalSpies.hostKeyAnswers.push(true);

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

        // A changed key shows both fingerprints in the same sheet; replacing is remembered without a second question.
        expect(modalSpies.show).toHaveBeenCalledTimes(1);
        expect(modalSpies.show.mock.calls[0]![0]).toMatchObject({
            props: { request: { host: 'server.example.test', fingerprint: 'SHA256:new', existingFingerprint: 'SHA256:old' } },
        });
        expect(modalSpies.confirm).not.toHaveBeenCalled();
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
