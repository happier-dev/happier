import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage, useSettingMutable } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { Modal } from '@/modal';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { Slider } from '@/components/ui/forms/Slider';
import { useSettingPreview } from '@/sync/store/settingsPreview';
import { useGlassMaterialSettings } from '@/components/ui/glass/useGlassMaterialSettings';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const originalState = storage.getState();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(originalState, true); });

describe('write-owned settings presentation and lifetime', () => {
    it('writes each Bot motion choice once through the Account settings Action without approval', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        const writer = await renderHook(() => useSettingMutable('botMotion'));
        try {
            for (const choice of ['reactions', 'still', 'lively'] as const) {
                const before = account.settingsWrites.length;
                await act(async () => {
                    writer.getCurrent()[1](choice);
                    await vi.waitFor(() => expect(account.persistedSettings.botMotion).toBe(choice));
                });
                expect(account.settingsWrites.length - before).toBe(1);
                expect(writer.getCurrent()[0]).toBe(choice);
                expect(account.artifacts.list()).toHaveLength(0);
            }
        } finally { await writer.unmount(); await account.dispose(); }
    });
    it('keeps ordinary Action ingress and its signal bound to the closed view', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ glassTintIntensity: 50 }) });
        const reader = await renderHook(() => useMountedActionExecution(account.scope));
        try {
            const execution = reader.getCurrent();
            const signal = execution.getSignal();
            expect(signal.aborted).toBe(false);
            await reader.unmount();
            expect(signal.aborted).toBe(true);
            expect(await execution.execute('settings.get', { anchor: 'appearance.glassTint' }))
                .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(account.settingsWrites).toHaveLength(0);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps a directly mounted Settings Action alive after its view closes', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ glassTintIntensity: 50,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const request = account.request.getMockImplementation()!;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        account.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method !== 'POST') {
                entered.resolve(); await release.promise;
            }
            return request(input, init);
        });
        const writer = await renderHook(() => useMountedActionExecution(account.scope));
        try {
            let write!: ReturnType<ReturnType<typeof useMountedActionExecution>['execute']>;
            await act(async () => { write = writer.getCurrent().execute('settings.set', { anchor: 'appearance.glassTint', value: 80 }); });
            await entered.promise;
            await writer.unmount();
            release.resolve();
            await act(async () => { expect((await write).ok).toBe(true); });
            expect(account.persistedSettings.glassTintIntensity).toBe(80);
        } finally { release.resolve(); standardCleanup(); await account.dispose(); }
    });
    it('shows a held glass preset through the shared material reader before acknowledgement', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ glassBlurEnabled: true,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const request = account.request.getMockImplementation()!;
        const release = createDeferred<void>();
        account.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method !== 'POST') await release.promise;
            return request(input, init);
        });
        const writer = await renderHook(useSettingActionFeedback);
        const reader = await renderHook(useGlassMaterialSettings);
        let write!: Promise<boolean>;
        try {
            await act(async () => { write = writer.getCurrent().setSetting({ anchor: 'appearance.glassPreset' }, 'solid'); });
            expect(reader.getCurrent().glassBlurEnabled).toBe(false);
            expect(storage.getState().settings.glassBlurEnabled).toBe(true);
            release.resolve();
            await act(async () => { expect(await write).toBe(true); });
        } finally { release.resolve(); standardCleanup(); await account.dispose(); }
    });
    it('withdraws an Ask hold while parked and leaves rejected choices uncommitted', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ glassTintIntensity: 50,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        }) });
        const writer = await renderHook(useSettingActionFeedback);
        const reader = await renderHook(() => useSetting('glassTintIntensity'));
        let write!: Promise<boolean>;
        try {
            await act(async () => { write = writer.getCurrent().setSetting({ anchor: 'appearance.glassTint' }, 80); });
            await act(async () => { await vi.waitFor(() => {
                expect(account.artifacts.list()).toHaveLength(1);
                expect(reader.getCurrent()).toBe(50);
            }); });
            expect(account.settingsWrites).toHaveLength(0);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            await act(async () => { expect(await write).toBe(false); });
            expect(reader.getCurrent()).toBe(50);
            expect(account.settingsWrites).toHaveLength(0);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('hands a Slider gesture to its write hold without exposing the old value at release', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ glassTintIntensity: 50,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const request = account.request.getMockImplementation()!;
        const release = createDeferred<void>();
        const shown: number[] = [];
        function Control() {
            const value = useSetting('glassTintIntensity');
            const preview = useSettingPreview('glassTintIntensity');
            const { setSetting } = useSettingActionFeedback();
            React.useLayoutEffect(() => { shown.push(value); }, [value]);
            return <Slider testID="hold-slider" min={0} max={100} step={1} value={value}
                onValuePreview={preview} onValueChange={next => { void setSetting({ anchor: 'appearance.glassTint' }, next); }} />;
        }
        account.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method !== 'POST') await release.promise;
            return request(input, init);
        });
        try {
            const screen = await renderScreen(<Control />);
            const track = screen.findByTestId('hold-slider-track')!;
            await act(async () => {
                track.props.onLayout({ nativeEvent: { layout: { width: 100, height: 40, x: 0, y: 0 } } });
                track.props.onResponderGrant({ nativeEvent: { locationX: 80, pageX: 80 } });
            });
            expect(shown.at(-1)).toBe(80);
            shown.length = 0;
            await act(async () => { track.props.onResponderRelease(); });
            expect(screen.findByTestId('hold-slider')!.props.accessibilityValue.now).toBe(80);
            expect(shown).not.toContain(50);
            expect(storage.getState().settings.glassTintIntensity).toBe(50);
            release.resolve();
            await act(async () => { await vi.waitFor(() => expect(account.persistedSettings.glassTintIntensity).toBe(80)); });
        } finally { release.resolve(); standardCleanup(); await account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('keeps a %s choice and its presentation hold after the author unmounts before POST', async mode => {
        const account = await createSecretSettingsTestHarness({ mode, settings: settingsParse({ glassTintIntensity: 50,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const originalRequest = account.request.getMockImplementation()!;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const secondEntered = createDeferred<void>();
        const releaseSecond = createDeferred<void>();
        let baselineReads = 0;
        let shown = 0;
        let unrelatedRenders = 0;
        function Reader() { shown = useSetting('glassTintIntensity'); return null; }
        function Unrelated() { useSetting('showFlavorIcons'); unrelatedRenders++; return null; }
        const writer = await renderHook(useSettingActionFeedback);
        await renderScreen(<><Reader /><Unrelated /></>);
        const before = unrelatedRenders;
        account.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method !== 'POST') {
                if (++baselineReads === 1) { entered.resolve(); await release.promise; }
                else { secondEntered.resolve(); await releaseSecond.promise; }
            }
            return originalRequest(input, init);
        });
        let write!: Promise<boolean>;
        try {
            await act(async () => { write = writer.getCurrent().setSetting({ anchor: 'appearance.glassTint' }, 80); });
            await entered.promise;
            expect(shown).toBe(80);
            expect(storage.getState().settings.glassTintIntensity).toBe(50);
            expect(account.settingsWrites).toHaveLength(0);
            expect(unrelatedRenders).toBe(before);
            let secondWrite!: Promise<boolean>;
            await act(async () => { secondWrite = writer.getCurrent().setSetting({ anchor: 'appearance.glassTint' }, 90); });
            await writer.unmount();
            expect(shown).toBe(90);
            release.resolve();
            await act(async () => { expect(await write).toBe(true); });
            await secondEntered.promise;
            expect(account.persistedSettings.glassTintIntensity).toBe(80);
            expect(shown).toBe(90);
            releaseSecond.resolve();
            await act(async () => { expect(await secondWrite).toBe(true); });
            expect(account.persistedSettings.glassTintIntensity).toBe(90);
            expect(shown).toBe(90);
        } finally { release.resolve(); releaseSecond.resolve(); standardCleanup(); await account.dispose(); }
    });

    it('presents a failed settings write after its author unmounts', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const originalRequest = account.request.getMockImplementation()!;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const writer = await renderHook(useSettingActionFeedback);
        account.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method !== 'POST') {
                entered.resolve(); await release.promise;
                throw new Error('transport unavailable');
            }
            return originalRequest(input, init);
        });
        let write!: Promise<boolean>;
        try {
            await act(async () => { write = writer.getCurrent().setSetting({ anchor: 'appearance.glassTint' }, 80); });
            await entered.promise;
            await writer.unmount();
            vi.mocked(Modal.alert).mockClear();
            release.resolve();
            await act(async () => { expect(await write).toBe(false); });
            expect(Modal.alert).toHaveBeenCalledTimes(1);
        } finally { release.resolve(); standardCleanup(); await account.dispose(); }
    });
});

