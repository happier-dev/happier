import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
        });
    },
});

const LOCAL_PARAMS = {
    target: { kind: 'local' },
    surface: 'desktop.ui',
    mode: 'user',
    // The app's release ring: local tasks acquire the managed CLI from it.
    channel: 'stable',
};

async function createHarness() {
    const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
    const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

    let nextTaskId = 1;
    const listeners = new Map<string, {
        onEvent: (payload: unknown) => void;
        onResult: (payload: unknown) => void;
    }>();
    const starts: Array<{ kind: string; params: unknown }> = [];

    const runner = createSystemTaskRunner({
        bridge: {
            async start(spec) {
                const parsed = SystemTaskSpecSchema.parse(spec);
                starts.push({ kind: parsed.kind, params: parsed.params });
                return `task_${nextTaskId++}:${parsed.kind}`;
            },
            async subscribe(taskId, listenerSet) {
                listeners.set(taskId, listenerSet);
                return () => {
                    listeners.delete(taskId);
                };
            },
            async cancel() {},
            async respond() {},
        },
    });

    const { LocalCliPathExposureSection } = await import('./LocalCliPathExposureSection');
    const screen = await renderScreen(React.createElement(LocalCliPathExposureSection, { runner }));

    return {
        screen,
        starts,
        row(testID: string) {
            return screen.findAllByTestId(testID)
                .find((node) => typeof node.type !== 'string' && node.props.title !== undefined)?.props;
        },
        async resolve(taskId: string, data: Record<string, unknown>) {
            await renderer.act(async () => {
                listeners.get(taskId)?.onResult({ protocolVersion: 1, taskId, ok: true, data });
            });
        },
        async fail(taskId: string, message: string) {
            await renderer.act(async () => {
                listeners.get(taskId)?.onResult({
                    protocolVersion: 1,
                    taskId,
                    ok: false,
                    error: { code: 'cli_path_exposure_failed', message },
                });
            });
        },
    };
}

describe('LocalCliPathExposureSection', () => {
    let Modal: (typeof import('@/modal'))['Modal'];
    beforeEach(async () => {
        ({ Modal } = await import('@/modal'));
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(false);
    });

    afterEach(() => vi.unstubAllGlobals());

    it('shows Desktop cleanup only inside the native Desktop app', async () => {
        const browser = await createHarness();
        expect(browser.screen.findByTestId('settings.localDesktop.cleanup')).toBeNull();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
        const desktop = await createHarness();
        expect(desktop.screen.findByTestId('settings.localDesktop.cleanup')).not.toBeNull();
    });

    it('leaves Desktop components untouched when cleanup is cancelled', async () => {
        const invoke = vi.fn();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const harness = await createHarness();
        await harness.screen.pressByTestIdAsync('settings.localDesktop.cleanup');
        expect(Modal.confirm).toHaveBeenCalledWith(
            'machine.cliPath.cleanupConfirmTitle', 'machine.cliPath.cleanupConfirmBody',
            expect.objectContaining({ destructive: true }),
        );
        expect(invoke).not.toHaveBeenCalled();
        expect(harness.row('settings.localDesktop.cleanup')?.disabled).toBe(false);
    });

    it('cleans up on explicit confirmation and quits only after cleanup succeeds', async () => {
        const cleanup = createDeferred<void>();
        const invoke = vi.fn(async (command: string) => {
            if (command === 'desktop_uninstall_components') await cleanup.promise;
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const harness = await createHarness();
        let press: Promise<void> | undefined;
        await renderer.act(async () => {
            press = harness.row('settings.localDesktop.cleanup')?.onPress();
        });
        expect(invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_uninstall_components']);
        expect(harness.row('settings.localDesktop.cleanup')?.disabled).toBe(true);
        expect(harness.row('settings.localCliPath.add')?.disabled).toBe(true);
        await renderer.act(async () => {
            cleanup.resolve();
            await press;
        });
        expect(invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_uninstall_components', 'desktop_finish_shutdown']);
    });

    it('keeps failures visible and allows retry without quitting', async () => {
        const invoke = vi.fn().mockRejectedValueOnce('Cannot remove Desktop service: access denied').mockResolvedValue(undefined);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const harness = await createHarness();
        await harness.screen.pressByTestIdAsync('settings.localDesktop.cleanup');
        expect(harness.row('settings.localDesktop.cleanupStatus')?.subtitle)
            .toContain('Cannot remove Desktop service: access denied');
        expect(harness.row('settings.localDesktop.cleanup')?.disabled).toBe(false);
        expect(invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_uninstall_components']);
        await harness.screen.pressByTestIdAsync('settings.localDesktop.cleanup');
        expect(invoke.mock.calls.map(([command]) => command))
            .toEqual(['desktop_uninstall_components', 'desktop_uninstall_components', 'desktop_finish_shutdown']);
    });

    it('admits one confirmation at a time and blocks cleanup during a PATH task', async () => {
        const confirmation = createDeferred<boolean>();
        const invoke = vi.fn();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        vi.mocked(Modal.confirm).mockReturnValue(confirmation.promise);
        const harness = await createHarness();
        const row = harness.row('settings.localDesktop.cleanup');
        let first: Promise<void> | undefined;
        await renderer.act(async () => {
            first = row?.onPress();
            await row?.onPress();
        });
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        await renderer.act(async () => {
            confirmation.resolve(false);
            await first;
        });
        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');
        await harness.row('settings.localDesktop.cleanup')?.onPress();
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('starts the ensure task from the add row and shows the returned reload hint', async () => {
        const harness = await createHarness();

        expect(harness.starts).toEqual([]);
        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');

        expect(harness.starts).toEqual([{ kind: 'cli.pathExposure.ensure.v1', params: LOCAL_PARAMS }]);

        await harness.resolve('task_1:cli.pathExposure.ensure.v1', {
            changed: true,
            shellReloadHint: 'Open a new terminal, or run: source "/home/me/.zshrc"',
            failure: null,
        });

        expect(harness.row('settings.localCliPath.status')?.subtitle)
            .toBe('Open a new terminal, or run: source "/home/me/.zshrc"');
    });

    it('reports an already-present entry without claiming a change', async () => {
        const harness = await createHarness();

        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');
        await harness.resolve('task_1:cli.pathExposure.ensure.v1', { changed: false, shellReloadHint: null, failure: null });

        expect(harness.row('settings.localCliPath.status')?.subtitle).toBe('machine.cliPath.alreadyPresent');
    });

    it('says which other happier already answers in the terminal when nothing was added (R17/R6)', async () => {
        const harness = await createHarness();
        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');
        await harness.resolve('task_1:cli.pathExposure.ensure.v1', {
            changed: false,
            shellReloadHint: null,
            failure: null,
            existingCommand: '/opt/homebrew/bin/happier',
        });

        const subtitle = String(harness.row('settings.localCliPath.status')?.subtitle ?? '');
        expect(subtitle).toContain('machine.cliPath.existingCommand');
        expect(subtitle).toContain('/opt/homebrew/bin/happier');
    });

    it('starts the remove task from the remove row and reports what was removed', async () => {
        const harness = await createHarness();

        await harness.screen.pressByTestIdAsync('settings.localCliPath.remove');

        expect(harness.starts).toEqual([{ kind: 'cli.pathExposure.remove.v1', params: LOCAL_PARAMS }]);

        await harness.resolve('task_1:cli.pathExposure.remove.v1', { removed: true, failure: null });
        expect(harness.row('settings.localCliPath.status')?.subtitle).toBe('machine.cliPath.removed');

        await harness.screen.pressByTestIdAsync('settings.localCliPath.remove');
        await harness.resolve('task_2:cli.pathExposure.remove.v1', { removed: false, failure: null });
        expect(harness.row('settings.localCliPath.status')?.subtitle).toBe('machine.cliPath.nothingToRemove');
    });

    it('surfaces a task failure message and keeps both actions available', async () => {
        const harness = await createHarness();

        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');
        await harness.fail('task_1:cli.pathExposure.ensure.v1', 'Could not update shell profile /home/me/.profile: EACCES');

        expect(harness.row('settings.localCliPath.status')?.subtitle)
            .toBe('Could not update shell profile /home/me/.profile: EACCES');
        expect(harness.row('settings.localCliPath.add')?.disabled).toBe(false);
        expect(harness.row('settings.localCliPath.remove')?.disabled).toBe(false);
    });
});
