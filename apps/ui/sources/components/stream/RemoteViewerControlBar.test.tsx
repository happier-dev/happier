import * as React from 'react';
import type { TextInput } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { act, renderScreen } from '@/dev/testkit';
import { useBrowserSoftKeyboard } from '@/components/browser/streamed/useBrowserSoftKeyboard';
import { RemoteViewerControlBar } from './RemoteViewerControlBar';
import { useRemoteViewerActions } from '@happier-dev/plugin-ui/presentation';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { t } from '@/text';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The browser's hardware media queries are the platform boundary; the shared primary-pointer owner
// classifies them for real underneath.
const pointer = vi.hoisted(() => ({ coarse: true }));
Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: (query: string) => ({
    matches: query === '(pointer: coarse)' || query === '(hover: none)' ? pointer.coarse
        : query === '(pointer: fine)' || query === '(hover: hover)' ? !pointer.coarse : false,
    media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
}) });

function Bar() {
    const actions = useRemoteViewerActions({ enabled: true, sendGesture: () => {} });
    return <RemoteViewerControlBar enabled actions={actions} testID="controls" controls={{
        mode: 'direct', setMode: () => {}, resetZoom: () => {},
    }} />;
}

describe('remote viewer control bar', () => {
    it('publishes exactly the visible viewer controls for Browser and Computer and retires hidden control addresses', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://viewer-controls.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        pointer.coarse = true;
        let selectedMode = 'direct';
        let resetCount = 0;
        let keyboard!: ReturnType<typeof useBrowserSoftKeyboard>;
        let nativeFocused = false;
        function Host({ enabled = true }: Readonly<{ enabled?: boolean }>) {
            const [mode, setMode] = React.useState<'direct' | 'trackpad'>('direct');
            selectedMode = mode;
            const actions = useRemoteViewerActions({ enabled, sendGesture: () => {} });
            keyboard = useBrowserSoftKeyboard({ enabled, manual: true, target: null,
                sendText: actions.sendText, sendKey: actions.sendKey });
            const commands = useCurrentUiContextComposedCommands();
            usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
            return <RemoteViewerControlBar enabled={enabled} actions={{ ...actions, keyboard }} testID="controls" controls={{ mode,
                setMode, resetZoom: () => { resetCount += 1; } }} />;
        }
        const screen = await renderMountedCurrentUiContext(<Host />);
        // The native focus target is the system boundary; keyboard intent and state remain real.
        const focusTarget = {
            focus: () => { nativeFocused = true; keyboard.sentinelProps.onFocus?.({} as Parameters<NonNullable<typeof keyboard.sentinelProps.onFocus>>[0]); },
            blur: () => { nativeFocused = false; keyboard.sentinelProps.onBlur?.({} as Parameters<NonNullable<typeof keyboard.sentinelProps.onBlur>>[0]); },
            setNativeProps: () => {},
        };
        Object.assign(keyboard.inputRef, { current: focusTarget as unknown as TextInput });
        const executor = createDefaultActionExecutor();
        const caller = { serverId: server.id, surface: 'agent' as const, authority: 'account_automation' as const };
        async function inventory() {
            const read = await executor.execute('ui.current_context.read', {}, caller);
            if (!read.ok) throw new Error(read.errorCode);
            return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
        }
        async function invoke(title: string) {
            const command = (await inventory()).find(row => row.title === title);
            expect(command, title).toBeDefined();
            await act(async () => expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, caller)).toMatchObject({ ok: true }));
            return command!.id;
        }
        const tabs = [t('browserPresence.remoteControls.touch'), t('browserPresence.remoteControls.modifiers'),
            t('browserPresence.remoteControls.arrows'), t('browserPresence.remoteControls.clipboard')];
        try {
            expect((await inventory()).map(row => row.title).sort()).toEqual([...tabs,
                t('browserPresence.stream.directMode'), t('browserPresence.stream.trackpadMode'), t('browserPresence.stream.resetZoom'),
                t('browserPresence.interaction.showKeyboard')].sort());
            await invoke(t('browserPresence.interaction.showKeyboard'));
            expect(nativeFocused).toBe(true);
            await screen.pressByTestIdAsync('controls-keyboard');
            expect(nativeFocused).toBe(false);
            const trackpadAddress = await invoke(t('browserPresence.stream.trackpadMode'));
            expect(selectedMode).toBe('trackpad');
            await screen.pressByTestIdAsync('controls-mode:direct');
            expect(selectedMode).toBe('direct');
            await invoke(t('browserPresence.stream.resetZoom'));
            expect(resetCount).toBe(1);
            await screen.pressByTestIdAsync('controls-reset-zoom');
            expect(resetCount).toBe(2);
            await invoke(t('browserPresence.remoteControls.arrows'));
            expect(screen.findByTestId('controls-key-ArrowLeft')).not.toBeNull();
            expect((await inventory()).map(row => row.title).sort()).toEqual([...tabs, t('browserPresence.interaction.showKeyboard')].sort());
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: trackpadAddress }, caller)).toMatchObject({ ok: false });
            await screen.update(<Host enabled={false} />);
            expect(await inventory()).toEqual([]);
        } finally {
            await screen.unmount();
            await home.dispose();
        }
    });

    it('stands over the picture only for a finger; a mouse and keyboard drive the picture directly', async () => {
        pointer.coarse = false;
        const precise = await renderScreen(<Bar />);
        try { expect(precise.findHostByTestId('controls')).toBeFalsy(); } finally { await precise.unmount(); }
        pointer.coarse = true;
        const touch = await renderScreen(<Bar />);
        try { expect(touch.findHostByTestId('controls')).toBeTruthy(); } finally { await touch.unmount(); }
    });

    it('stands over the picture only while this viewer controls it; a passive viewer sees the page alone', async () => {
        pointer.coarse = true;
        function Passive() {
            const actions = useRemoteViewerActions({ enabled: false, sendGesture: () => {} });
            return <RemoteViewerControlBar enabled={false} actions={actions} testID="controls" controls={{
                mode: 'direct', setMode: () => {}, resetZoom: () => {},
            }} />;
        }
        const passive = await renderScreen(<Passive />);
        try { expect(passive.findHostByTestId('controls')).toBeFalsy(); } finally { await passive.unmount(); }
    });
});

describe('remote viewer keyboard toggle', () => {
    it('hides on a second pointer click even when the browser would blur the sentinel before click', async () => {
        let keyboard!: ReturnType<typeof useBrowserSoftKeyboard>;
        let nativeFocused = false;
        function Host() {
            const actions = useRemoteViewerActions({ enabled: true, sendGesture: () => {} });
            keyboard = useBrowserSoftKeyboard({ enabled: true, manual: true, target: null,
                sendText: actions.sendText, sendKey: actions.sendKey });
            return <RemoteViewerControlBar enabled actions={{ ...actions, keyboard }} testID="controls" controls={{
                mode: 'direct', setMode: () => {}, resetZoom: () => {},
            }} />;
        }
        const screen = await renderScreen(<Host />);
        // TextInput and the browser's default focus transfer are the platform boundary.
        const host = {
            focus: () => { nativeFocused = true; keyboard.sentinelProps.onFocus?.({} as Parameters<NonNullable<typeof keyboard.sentinelProps.onFocus>>[0]); },
            blur: () => { nativeFocused = false; keyboard.sentinelProps.onBlur?.({} as Parameters<NonNullable<typeof keyboard.sentinelProps.onBlur>>[0]); },
            setNativeProps: () => {},
        };
        Object.assign(keyboard.inputRef, { current: host as unknown as TextInput });
        const click = async () => {
            let prevented = false;
            const control = screen.findHostByTestId('controls-keyboard')!;
            await act(async () => { control.props.onPointerDown?.({ preventDefault: () => { prevented = true; } }); });
            if (!prevented) await act(async () => { host.blur(); });
            // RNW delays press-in until after the browser's default focus transfer.
            await act(async () => { control.props.onPressIn?.({ preventDefault: () => {} }); });
            await act(async () => { screen.findByTestId('controls-keyboard')?.props.onPress(); });
        };
        try {
            await click();
            expect(nativeFocused).toBe(true);
            expect(keyboard.focused).toBe(true);
            await click();
            expect(nativeFocused).toBe(false);
            expect(keyboard.focused).toBe(false);
            await click();
            expect(nativeFocused).toBe(true);
        } finally { await screen.unmount(); }
    });
});
