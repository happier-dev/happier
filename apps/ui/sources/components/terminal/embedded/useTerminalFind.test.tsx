import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { KeyboardShortcutProvider, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createWebViewFindEngine } from '../xterm/webview/findBridge';
import { useTerminalFind } from './useTerminalFind';
import { useEmbeddedTerminalPresentation } from './useEmbeddedTerminalPresentation';
import type { EmbeddedTerminalPaneController } from './types';
import { useSessionTerminalTabMenu } from '@/components/sessions/terminal/strip/useSessionTerminalTabMenu';
import { reduceSessionTerminalWorkspace, EMPTY_TERMINAL_WORKSPACE } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { describeSessionTerminal, describeSessionTerminalTab } from '@/components/sessions/terminal/presentation/describeSessionTerminal';
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'ios', select: <T,>(values: { ios?: T; native?: T; default?: T }) => values.ios ?? values.native ?? values.default } }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
describe('mounted terminal Find presentation', () => {
    it('focuses the same retained renderer only when its Shell becomes active', async () => {
        const focus = vi.fn();
        const terminalRef = { current: { focus, write: () => true, clear: () => {} } };
        const noop = () => {};
        const controller: EmbeddedTerminalPaneController = {
            status: 'connected', error: null, detectedUrl: null, onInput: noop, onPaste: noop,
            onResize: noop, onReady: noop, onWriteComplete: noop, clearTerminal: noop,
            requestRestart: noop, retryConnect: noop, dismissDetectedUrl: noop,
        };
        function Pane({ focused }: { focused: boolean }) {
            useEmbeddedTerminalPresentation({ scopeId: 'activation-focus', terminalKey: 'same-renderer',
                terminalId: 'same-renderer', available: true, focused, controller, terminalRef });
            return null;
        }
        const tree = (active: boolean, focused = true) => <KeyboardShortcutProvider handlers={{}}>
            <PluginSurfaceFocusEligibilityProvider active={active}><Pane focused={focused} /></PluginSurfaceFocusEligibilityProvider>
        </KeyboardShortcutProvider>;
        const screen = await renderScreen(tree(false));
        expect(focus).not.toHaveBeenCalled();
        await screen.update(tree(true));
        expect(focus).toHaveBeenCalledTimes(1);
        await screen.update(tree(true));
        expect(focus).toHaveBeenCalledTimes(1);
        await screen.update(tree(false));
        await screen.update(tree(true, false));
        expect(focus).toHaveBeenCalledTimes(1);
        await screen.update(tree(true));
        expect(focus).toHaveBeenCalledTimes(2);
        await screen.unmount();
    });
    it('opens menu Find on its own renderer when the same terminal is mounted twice', async () => {
        const first = createWebViewFindEngine(() => {}).engine;
        const second = createWebViewFindEngine(() => {}).engine;
        const workspace = reduceSessionTerminalWorkspace(EMPTY_TERMINAL_WORKSPACE, {
            type: 'open', terminal: { id: 'shared-shell', target: { kind: 'workspace_shell' } },
        });
        const context = { agentId: null, agentName: null, agentAsking: false, agentTerminalHost: null,
            sessionMachineId: null, sessionMachineName: null, machineName: () => null };
        const tabs = workspace.tabs.map(tab => describeSessionTerminalTab(tab,
            tab.terminals.map(member => describeSessionTerminal(member, null, context))));
        const noop = () => {};
        const controller: EmbeddedTerminalPaneController = {
            status: 'connected', error: null, detectedUrl: null, onInput: noop, onPaste: noop,
            onResize: noop, onReady: noop, onWriteComplete: noop, clearTerminal: noop,
            requestRestart: noop, retryConnect: noop, dismissDetectedUrl: noop,
        };
        const menus: { first?: ReturnType<typeof useSessionTerminalTabMenu>; second?: ReturnType<typeof useSessionTerminalTabMenu> } = {};
        function Presentation({ name, engine, mounted = true }: { name: 'first' | 'second'; engine: typeof first; mounted?: boolean }) {
            const menu = useSessionTerminalTabMenu({ scopeId: 'dual-renderer-find', workspace, tabs, run: noop });
            menus[name] = menu;
            return mounted ? <Pane engine={engine} presentationId={menu.presentationId} /> : null;
        }
        function Pane({ engine, presentationId }: { engine: typeof first; presentationId: string }) {
            const terminalRef = React.useRef({ find: engine, write: () => true, clear: noop });
            const presentation = useEmbeddedTerminalPresentation({ scopeId: 'dual-renderer-find',
                terminalKey: 'shared-shell', terminalId: 'shared-shell', available: true, focused: true,
                presentationId, controller, terminalRef });
            const find = useTerminalFind({ title: 'Shell', focused: true, findSurfaceId: presentation.findSurfaceId, terminalRef }, false);
            React.useEffect(() => { find.onFindEngine(engine); }, [engine, find.onFindEngine]);
            return find.bar;
        }
        const tree = (firstMounted = true) => <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>
            <Presentation name="first" engine={first} mounted={firstMounted} /><Presentation name="second" engine={second} />
        </PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
        const screen = await renderScreen(tree());
        const tabId = workspace.activeTabId!;
        await act(async () => { menus.first?.select(tabId, 'find'); });
        expect(first.getSnapshot().open).toBe(true);
        expect(second.getSnapshot().open).toBe(false);
        expect(screen.findAllHostsByTestId('terminal-find.input')).toHaveLength(1);
        await act(async () => { first.close(); menus.second?.select(tabId, 'find'); });
        expect(second.getSnapshot().open).toBe(true);
        await act(async () => { second.close(); });
        await screen.update(tree(false));
        expect(menus.first?.items(tabId).some(item => item.id === 'find')).toBe(false);
        await act(async () => { menus.first?.select(tabId, 'find'); });
        expect(second.getSnapshot().open).toBe(false);
        await act(async () => { menus.second?.select(tabId, 'find'); });
        expect(second.getSnapshot().open).toBe(true);
        await screen.unmount();
    });
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
