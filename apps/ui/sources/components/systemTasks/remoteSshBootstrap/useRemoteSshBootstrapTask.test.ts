import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { useRemoteSshBootstrapTask } from './useRemoteSshBootstrapTask';

// The native navigation SDK is not exercised by this OS-task boundary test. The
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
// package router stub does not resolve this SDK subpath imported by the app shell.
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
// App/build environment is a boundary; task construction and release-ring selection remain real.
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
// Canonical UI presentation boundaries; internal task/feed/arrival decisions remain real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(() => standardCleanup());
describe('retained SSH task', () => {
    it('hands admitted credentials to the task without reusing them for a later UI password prompt', async () => {
        const manual = createManualSystemTaskRunner('native');
        const form = { sshUsername: '', sshHost: 'build-box', sshPort: '', sshAuth: 'password' as const,
            sshPassword: 'private-reference-value', identityFilePath: '', identityPrivateKey: '', installRelayRuntime: false };
        const hook = await renderHook(() => useRemoteSshBootstrapTask({ runner: manual.runner, relayUrl: 'https://home.example.test' }));
        let taskId = '';
        await act(async () => { taskId = await hook.getCurrent().start(form, spec => manual.runner.start(spec)); });
        expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({ ssh: expect.objectContaining({ password: 'private-reference-value' }) }),
        }));
        await act(async () => manual.emitEvent(taskId, { type: 'prompt', message: 'Password needed',
            data: { kind: 'ssh.password', target: 'build-box' } }));
        expect(hook.getCurrent().prompt?.kind).toBe('ssh.password');
        expect(manual.bridge.respond).not.toHaveBeenCalled();
    });

    it('resumes a native password prompt and observes completion after presenter remount', async () => {
        const manual = createManualSystemTaskRunner('native');
        const form = {
            sshUsername: '', sshHost: 'build-box', sshPort: '', sshAuth: 'password' as const,
            sshPassword: '', identityFilePath: '', identityPrivateKey: '', installRelayRuntime: false,
        };
        const first = await renderHook(() => useRemoteSshBootstrapTask({ runner: manual.runner, relayUrl: 'https://home.example.test' }));
        let taskId = '';
        await act(async () => { taskId = await first.getCurrent().start(form); });
        await first.unmount();
        const resumed = await renderHook(() => useRemoteSshBootstrapTask({
            runner: manual.runner, relayUrl: 'https://home.example.test', taskId,
        }));
        await act(async () => manual.emitEvent(taskId, {
            type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'build-box' },
        }));
        expect(resumed.getCurrent().prompt?.kind).toBe('ssh.password');
        await act(async () => resumed.getCurrent().answerPasswordPrompt({ ...form, sshPassword: 'secret' }));
        expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'secret' });
        await act(async () => manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true, data: { machineId: 'ssh-machine' } }));
        expect(resumed.getCurrent().completedMachineId).toBe('ssh-machine');
        expect(resumed.getCurrent().prompt).toBeNull();
        expect(resumed.getCurrent().activeTaskSnapshot?.awaitingInput).toBe(false);
        await resumed.unmount();
    });
});
