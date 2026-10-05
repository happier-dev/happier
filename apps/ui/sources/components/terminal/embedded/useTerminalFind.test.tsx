import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { KeyboardShortcutProvider, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createWebViewFindEngine } from '../xterm/webview/findBridge';
import { useTerminalFind } from './useTerminalFind';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'ios', select: <T,>(values: { ios?: T; native?: T; default?: T }) => values.ios ?? values.native ?? values.default } }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/sync/domains/state/storage', async () => {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const storage = Object.assign((selector: (value: { settings: typeof settingsDefaults }) => unknown) => selector({ settings: settingsDefaults }), { getState: () => ({ settings: settingsDefaults }) });
    return (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({ storage });
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
describe('mounted terminal Find presentation', () => {
    it('routes Find only to the focused split and cannot address a hidden leaf', async () => {
        const left = createWebViewFindEngine(() => {}).engine;
        const right = createWebViewFindEngine(() => {}).engine;
        const runtime: { current: ReturnType<typeof useFindSurfaceRuntime> | null } = { current: null };
        function Pane({ engine, focused, id }: { engine: typeof left; focused: boolean; id: string }) {
            const terminalRef = React.useRef({ find: engine, write: () => true, clear: () => {} });
            const find = useTerminalFind({ title: 'Shell', focused, findSurfaceId: id, terminalRef }, false);
            React.useEffect(() => { find.onFindEngine(engine); }, [engine, find.onFindEngine]);
            return find.bar;
        }
        function Controls() { runtime.current = useFindSurfaceRuntime(); return null; }
        const tree = (leftFocused: boolean) => <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>
            <Controls /><Pane engine={left} focused={leftFocused} id="left" /><Pane engine={right} focused={!leftFocused} id="right" />
        </PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
        const screen = await renderScreen(tree(true));
        await act(async () => { expect(runtime.current?.open('right')).toBe(false); expect(runtime.current?.open()).toBe(true); });
        expect(left.getSnapshot().open).toBe(true); expect(right.getSnapshot().open).toBe(false);
        await screen.update(tree(false));
        expect(left.getSnapshot().open).toBe(false);
        await act(async () => { runtime.current?.open(); });
        expect(right.getSnapshot().open).toBe(true);
        await screen.unmount();
    });
    it('seats the phone bar in place of keys, restores the renderer and retires a hidden leaf', async () => {
        const bridge = createWebViewFindEngine(() => {});
        const focus = vi.fn();
        const ref = { current: { find: bridge.engine, focus, write: () => true, clear: () => {} } };
        function Pane({ focused }: { focused: boolean }) {
            const find = useTerminalFind({ title: 'Shell', focused, findSurfaceId: 'terminal:test', terminalRef: ref }, true);
            React.useEffect(() => { find.onFindEngine(bridge.engine); }, [find.onFindEngine]);
            return <>{find.open ? find.bar : React.createElement('key-rail')}</>;
        }
        const tree = (focused: boolean) => <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active={focused}><Pane focused={focused} /></PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
        const screen = await renderScreen(tree(true));
        expect(screen.findAllByType('key-rail')).toHaveLength(1);
        await act(async () => { bridge.engine.open(); });
        expect(screen.findAllByType('key-rail')).toHaveLength(0);
        const field = screen.findByTestId('terminal-find.input');
        expect(field?.props.accessibilityLabel).toContain('Shell');
        await screen.pressByTestIdAsync('terminal-find.close');
        expect(focus).toHaveBeenCalledOnce();
        expect(screen.findAllByType('key-rail')).toHaveLength(1);
        await act(async () => { bridge.engine.open(); });
        await screen.update(tree(false));
        expect(bridge.engine.getSnapshot().open).toBe(false);
        await screen.unmount();
    });
});
