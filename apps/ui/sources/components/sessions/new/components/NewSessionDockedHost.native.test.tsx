import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { setNewSessionPickerReturnParams } from '../navigation/setNewSessionPickerReturnParams';
import { peekTempData, storeTempData } from '@/utils/sessions/tempDataStore';
import type { SecretRequirementModalResult } from '@/components/secrets/requirements';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';

const boundary = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android',
    dismiss: vi.fn(),
    secretResultId: '',
    back: [] as Array<() => boolean>,
    push: vi.fn(),
    replace: vi.fn(),
    dispatch: vi.fn(),
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: { get OS() { return boundary.os; }, select: (values: Record<string, unknown>) => values[boundary.os] ?? values.native ?? values.default },
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        Keyboard: { dismiss: boundary.dismiss, addListener: () => ({ remove() {} }), isVisible: () => false },
        BackHandler: { addEventListener: (_name: string, handler: () => boolean) => {
            boundary.back.push(handler);
            return { remove: () => { boundary.back = boundary.back.filter(current => current !== handler); } };
        } },
    });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({ settleTimingCallbacks: true }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: boundary.push, replace: boundary.replace } }).module);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@react-native-masked-view/masked-view', () => ({ default: 'MaskedView' }));
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

const account = createProviderSettingsAccountHarness();
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { NewSessionDockedHost } = await import('./NewSessionDockedHost');
const { NewSessionShellHostProvider, useNewSessionShellHost, useOpenNewSession } = await import('../navigation/newSessionEntry');
const { Pressable } = await import('react-native');
const { NavigationContext } = await import('@react-navigation/native');
const { HeaderHeightContext } = await import('@react-navigation/elements');

function Entry() {
    const open = useOpenNewSession();
    const shell = useNewSessionShellHost();
    return <><Pressable testID="open-dock" onPress={() => open()} />
        <Pressable testID="close-dock" onPress={shell?.close} />
        <Pressable testID="native-picker-return" onPress={() => setNewSessionPickerReturnParams({
            navigation: { getState: () => undefined, dispatch: boundary.dispatch },
            router: { replace: boundary.replace },
            currentParams: { newSessionHostDraftId: String(shell?.host.params.draftId) },
            routeParams: { profileId: 'native-profile' }, returnToHost: shell?.returnToHost,
        })} />
        <Pressable testID="native-secret-return" onPress={() => {
            boundary.secretResultId = storeTempData({ profileId: 'native-profile', revertOnCancel: false,
                result: { action: 'enterOnce', envVarName: 'DOCK_NATIVE_TEST_SECRET', value: 'fixture-only-value' } satisfies SecretRequirementModalResult });
            setNewSessionPickerReturnParams({
                navigation: { getState: () => undefined, dispatch: boundary.dispatch },
                router: { replace: boundary.replace },
                currentParams: { newSessionHostDraftId: String(shell?.host.params.draftId) },
                routeParams: { secretRequirementResultId: boundary.secretResultId }, returnToHost: shell?.returnToHost,
            });
        }} />
        {React.createElement('DockState', { visible: shell?.visible, draftId: shell?.host.params.draftId, profileId: shell?.host.params.profileId })}</>;
}

function Journey() {
    const [page, setPage] = React.useState(0);
    return <NavigationContext.Provider value={createNavigationPropMock()}><HeaderHeightContext.Provider value={0}>
        <NewSessionShellHostProvider><Entry />
            <NewSessionDockedHost><Pressable testID="page" onPress={() => setPage(page + 1)} accessibilityValue={{ now: page }} /></NewSessionDockedHost>
        </NewSessionShellHostProvider>
    </HeaderHeightContext.Provider></NavigationContext.Provider>;
}

describe('native shell Docked composer', () => {
    beforeAll(async () => { await import('../NewSessionScreen'); });
    afterEach(async () => { standardCleanup(); await account.reset(); boundary.back = []; boundary.push.mockClear(); boundary.replace.mockClear(); boundary.dispatch.mockClear(); boundary.dismiss.mockClear(); });
    it.each(['ios', 'android'] as const)('keeps the page and draft reachable outside the composer on %s', async os => {
        boundary.os = os;
        await account.restore({ settings: { newSessionPresentationModeV1: 'docked', glassPreset: 'solid' } });
        const nativeBlur = vi.fn();
        const screen = await renderScreen(<Journey />, {
            createNodeMock: element => element.type === 'HappierComposerInput' ? {
                blur: () => {
                    nativeBlur();
                    // The real Expo editor emits blur after resigning the native first responder.
                    if (typeof element.props.onComposerBlur === 'function') element.props.onComposerBlur();
                },
            } : null,
        });
        await screen.pressByTestIdAsync('open-dock');
        expect(screen.findAllHostsByTestId('new-session-docked-host')).toHaveLength(1);
        const state = () => screen.tree.root.findByType('DockState' as never).props;
        const first = state().draftId;
        const input = () => screen.tree.root.findAllByProps({ testID: 'new-session-composer-input' }).find(node => typeof node.props.onChangeText === 'function' && typeof node.props.value === 'string')!;
        const nativeInput = () => screen.tree.findByType('HappierComposerInput');
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string').map(node => node.props.testID)).toContain('new-session-composer-input'); });
        expect(input()).toBeDefined();
        if (os === 'android') expect(nativeInput().props.forwardHardwareBack).not.toBe(true);
        await act(async () => input().props.onChangeText('Retain this native draft'));
        await act(async () => input().props.onFocus());
        if (os === 'android') {
            expect(boundary.back).toHaveLength(1);
            expect(nativeInput().props.forwardHardwareBack).toBe(true);
        }
        expect(screen.findAllHostsByTestId('new-session-docked-dismiss-keyboard')).toHaveLength(1);
        await screen.pressByTestIdAsync('new-session-docked-dismiss-keyboard');
        expect(screen.findByTestId('page')?.props.accessibilityValue.now).toBe(0);
        expect(nativeBlur).toHaveBeenCalledOnce();
        expect(state().visible).toBe(true);
        expect(boundary.back).toHaveLength(0);
        if (os === 'android') expect(nativeInput().props.forwardHardwareBack).toBe(false);
        expect(screen.findAllHostsByTestId('new-session-docked-dismiss-keyboard')).toHaveLength(0);
        await screen.pressByTestIdAsync('native-picker-return');
        expect(state().profileId).toBe('native-profile');
        await screen.pressByTestIdAsync('native-secret-return');
        expect(boundary.secretResultId).not.toBe('');
        expect(peekTempData(boundary.secretResultId)).toBeNull();
        expect(state().draftId).toBe(first);
        expect(boundary.replace).not.toHaveBeenCalled();
        expect(boundary.dispatch).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('page');
        expect(screen.findByTestId('page')?.props.accessibilityValue.now).toBe(1);
        expect(screen.tree.root.findByType('DockState' as never).props.draftId).toBe(first);
        await screen.pressByTestIdAsync('close-dock');
        expect(screen.findAllHostsByTestId('new-session-docked-host')).toHaveLength(0);
        await screen.pressByTestIdAsync('open-dock');
        expect(screen.tree.root.findByType('DockState' as never).props.draftId).toBe(first);
        expect(input().props.value).toBe('Retain this native draft');
        expect(boundary.push).not.toHaveBeenCalled();
        if (os === 'android') {
            await act(async () => input().props.onFocus());
            await act(async () => { expect(boundary.back.at(-1)?.()).toBe(true); });
            expect(state().visible).toBe(false);
            await screen.pressByTestIdAsync('open-dock');
            expect(state().draftId).toBe(first);
            expect(input().props.value).toBe('Retain this native draft');
        }
        await act(async () => screen.unmount());
    });
});
