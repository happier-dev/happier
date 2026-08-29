import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import type { SystemTaskEvent, SystemTaskResult } from '@happier-dev/protocol';

import type { SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';
import type { SystemTaskRunState, SystemTaskRunner } from '../types';

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn(async () => false),
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
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => {
            if (key === 'machine.backgroundServiceModes.defaultFollowing') return 'default background service';
            if (key === 'machine.backgroundServiceModes.legacyPinned') return 'legacy pinned background service';
            if (key === 'machine.backgroundServiceModes.generic') return 'background service';
            return key;
        },
    });
});

function createRunnerStub() {
    const respond = vi.fn(async (_taskId: string, _answer: unknown) => {});
    const runner: SystemTaskRunner = {
        mode: 'dev',
        start: async () => 'task-1',
        cancel: async () => undefined,
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
    return { runner, respond };
}

function createSnapshot(taskId: string): SystemTaskRunState {
    return {
        taskId,
        status: 'running',
        currentStepId: 'setup.thisComputer.preflight.releaseChannel',
        latestMessage: null,
        awaitingInput: true,
        cancelRequested: false,
        events: [],
        result: null,
    };
}

afterEach(() => {
    standardCleanup();
    modalSpies.confirm.mockReset();
    modalSpies.confirm.mockResolvedValue(false);
});

describe('useThisComputerSetupPromptModals', () => {
    it('accepts the default release-channel switch prompt and responds to the system task', async () => {
        const { useThisComputerSetupPromptModals } = await import('./useThisComputerSetupPromptModals');
        const { runner, respond } = createRunnerStub();
        const taskId = 'task-1';
        const snapshot = createSnapshot(taskId);
        const prompt: SystemTaskPromptEnvelope = {
            kind: 'releaseChannel.switchDefaultForSetup',
            message: 'Make preview the default release-channel before installing the default background service targeting https://relay.example.test?',
            data: {
                kind: 'releaseChannel.switchDefaultForSetup',
                targetReleaseChannel: 'preview',
                currentDefaultReleaseChannel: 'stable',
                targetServerUrl: 'https://relay.example.test',
                managedReleaseChannels: [
                    {
                        releaseChannel: 'stable',
                        label: 'stable',
                        version: '1.0.0',
                    },
                    {
                        releaseChannel: 'preview',
                        label: 'preview',
                        version: '2.0.0',
                    },
                ],
            },
        };

        modalSpies.confirm.mockResolvedValue(true);

        await renderHook(() => useThisComputerSetupPromptModals({
            runner,
            taskId,
            snapshot,
            prompt,
        }));

        await flushHookEffects();

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        const confirmCalls = modalSpies.confirm.mock.calls as unknown as ReadonlyArray<readonly [
            string,
            string | undefined,
            Readonly<{ confirmText: string; cancelText: string }>,
        ]>;
        expect(confirmCalls[0]?.[0]).toBe(prompt.message);
        expect(confirmCalls[0]?.[1]).toContain('https://relay.example.test');
        expect(confirmCalls[0]?.[2]).toEqual({
            confirmText: 'common.continue',
            cancelText: 'common.cancel',
        });
        expect(respond).toHaveBeenCalledWith(taskId, { switchDefaultReleaseChannel: true });
    });

    it('declines conflicting background service replacement and sends a negative response', async () => {
        const { useThisComputerSetupPromptModals } = await import('./useThisComputerSetupPromptModals');
        const { runner, respond } = createRunnerStub();
        const taskId = 'task-2';
        const snapshot = createSnapshot(taskId);
        const prompt: SystemTaskPromptEnvelope = {
            kind: 'daemon.replaceLocalBackgroundServices',
            message: 'This computer already has conflicting Happier background services. Replace them before installing the default background service targeting https://relay.example.test?',
            data: {
                kind: 'daemon.replaceLocalBackgroundServices',
                targetReleaseChannel: 'preview',
                targetServerUrl: 'https://relay.example.test',
                services: [
                    {
                        label: 'com.happier.cli.daemon.stable.default',
                        releaseChannel: 'stable',
                        targetMode: 'pinned',
                        running: true,
                        serverUrl: 'https://relay.example.test',
                    },
                ],
            },
        };

        modalSpies.confirm.mockResolvedValue(false);

        await renderHook(() => useThisComputerSetupPromptModals({
            runner,
            taskId,
            snapshot,
            prompt,
        }));

        await flushHookEffects();

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        const confirmCalls = modalSpies.confirm.mock.calls as unknown as ReadonlyArray<readonly [
            string,
            string | undefined,
            Readonly<{ confirmText: string; cancelText: string }>,
        ]>;
        expect(confirmCalls[0]?.[0]).toBe(prompt.message);
        expect(confirmCalls[0]?.[1]).toContain('com.happier.cli.daemon.stable.default');
        expect(confirmCalls[0]?.[1]).toContain('legacy pinned background service');
        expect(confirmCalls[0]?.[1]).not.toContain('default-following');
        expect(confirmCalls[0]?.[1]).not.toContain(' • pinned');
        expect(confirmCalls[0]?.[2]).toEqual({
            confirmText: 'common.continue',
            cancelText: 'common.cancel',
        });
        expect(respond).toHaveBeenCalledWith(taskId, { replaceExistingServices: false });
    });

    it('accepts taking over a manual relay runtime and responds to the system task', async () => {
        const { useThisComputerSetupPromptModals } = await import('./useThisComputerSetupPromptModals');
        const { runner, respond } = createRunnerStub();
        const taskId = 'task-3';
        const snapshot = createSnapshot(taskId);
        const prompt: SystemTaskPromptEnvelope = {
            kind: 'daemon.takeOverManualRelayRuntimeForSetup',
            message: 'This computer is currently using a temporary relay process for https://relay.example.test. Continue to stop that process and switch this computer to the background service?',
            data: {
                kind: 'daemon.takeOverManualRelayRuntimeForSetup',
                targetReleaseChannel: 'preview',
                targetServerUrl: 'https://relay.example.test',
                currentReleaseChannel: 'stable',
                currentCliVersion: '0.2.0',
            },
        };

        modalSpies.confirm.mockResolvedValue(true);

        await renderHook(() => useThisComputerSetupPromptModals({
            runner,
            taskId,
            snapshot,
            prompt,
        }));

        await flushHookEffects();

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        const confirmCalls = modalSpies.confirm.mock.calls as unknown as ReadonlyArray<readonly [
            string,
            string | undefined,
            Readonly<{ confirmText: string; cancelText: string }>,
        ]>;
        expect(confirmCalls[0]?.[0]).toBe(prompt.message);
        expect(confirmCalls[0]?.[1]).toBeUndefined();
        expect(respond).toHaveBeenCalledWith(taskId, { takeOverManualRelayRuntime: true });
    });
});
