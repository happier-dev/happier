import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import type { BrowserEditableTargetV1 } from '@happier-dev/protocol';
import type { TextInput } from 'react-native';

import { useBrowserSoftKeyboard } from './useBrowserSoftKeyboard';
import { useBrowserViewerViewport } from './useBrowserViewerViewport';
import { BrowserSoftKeyboardButton } from './BrowserSoftKeyboardButton';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { t } from '@/text';

describe('browser viewer geometry and soft keyboard', () => {
    it('publishes the floating keyboard button only while visible and shares its native focus outcome', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://floating-keyboard-controls.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        let keyboard!: ReturnType<typeof useBrowserSoftKeyboard>;
        let nativeFocused = false;
        function Host({ enabled = true }: Readonly<{ enabled?: boolean }>) {
            keyboard = useBrowserSoftKeyboard({ enabled, target: { editable: true, inputMode: 'text', secret: true, multiline: false },
                sendText: () => {}, sendKey: () => {} });
            const commands = useCurrentUiContextComposedCommands();
            usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
            return <BrowserSoftKeyboardButton visible={keyboard.available && !keyboard.focused} onPress={keyboard.showKeyboard} testID="floating-keyboard" />;
        }
        const screen = await renderMountedCurrentUiContext(<Host />);
        // OS focus/blur is the boundary; the actual soft-keyboard owner decides availability and state.
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
        try {
            const commands = await inventory();
            expect(commands.map(row => row.title)).toEqual([t('browserPresence.interaction.showKeyboard')]);
            const address = commands[0]!.id;
            await act(async () => expect(await executor.execute('ui.current_context.command.invoke', { commandId: address }, caller)).toMatchObject({ ok: true, result: { value: null } }));
            expect(nativeFocused).toBe(true);
            expect(await inventory()).toEqual([]);
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: address }, caller)).toMatchObject({ ok: false });
            await act(async () => focusTarget.blur());
            expect((await inventory()).map(row => row.title)).toEqual([t('browserPresence.interaction.showKeyboard')]);
            await screen.pressByTestIdAsync('floating-keyboard-show');
            expect(nativeFocused).toBe(true);
            await screen.update(<Host enabled={false} />);
            expect(await inventory()).toEqual([]);
        } finally {
            await screen.unmount();
            await home.dispose();
        }
    });

    it('offers an explicitly summoned computer keyboard without browser editable metadata', async () => {
        const calls: string[] = [];
        const hook = await renderHook(({ enabled }) => useBrowserSoftKeyboard({ enabled, target: null, manual: true,
            sendText: text => calls.push(text), sendKey: key => calls.push(key) }), { initialProps: { enabled: false } });
        try {
            Object.assign(hook.getCurrent().inputRef, { current: {
                focus: () => calls.push('focus'), blur: () => calls.push('blur'), setNativeProps: () => {},
            } as unknown as TextInput });
            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().available).toBe(true);
            expect(calls).not.toContain('focus');
            act(() => hook.getCurrent().showKeyboard());
            expect(calls.at(-1)).toBe('focus');
            act(() => hook.getCurrent().sentinelProps.onChangeText?.('\u200b日本'));
            expect(calls.at(-1)).toBe('日本');
            await hook.rerender({ enabled: false });
            expect(calls.at(-1)).toBe('blur');
        } finally { await hook.unmount(); }
    });
    it('publishes only actual geometry/control changes, independently of frame renders and callback identity', async () => {
        const sent: unknown[] = [];
        const viewport = { width: 390, height: 844, deviceScaleFactor: 3 };
        const hook = await renderHook(({ controlling, size }) => useBrowserViewerViewport({ controlling, viewport: size,
            sendViewport: value => { sent.push(value); } }), { initialProps: { controlling: true, size: viewport } });
        try {
            for (let i = 0; i < 20; i++) await hook.rerender({ controlling: true, size: { ...viewport } });
            expect(sent).toEqual([viewport]);
            await hook.rerender({ controlling: false, size: { ...viewport, width: 1440 } });
            expect(sent).toHaveLength(1);
            await hook.rerender({ controlling: true, size: { ...viewport, height: 400 } });
            expect(sent).toEqual([viewport, { ...viewport, height: 400 }]);
        } finally { await hook.unmount(); }
    });

    it('relays committed Unicode text and deletion while withholding IME candidates and disabled input', async () => {
        const sent: Array<{ text: string } | { key: string }> = [];
        const target: BrowserEditableTargetV1 = { editable: true, inputMode: 'text', secret: true, multiline: false };
        const hook = await renderHook(({ enabled }) => useBrowserSoftKeyboard({ enabled, target,
            sendText: text => { sent.push({ text }); }, sendKey: key => { sent.push({ key }); } }), { initialProps: { enabled: true } });
        try {
            const keyboard = hook.getCurrent();
            expect(keyboard.sentinelProps).toMatchObject({ secureTextEntry: true, autoCorrect: false, autoComplete: 'off' });
            act(() => {
                keyboard.sentinelProps.onChangeText?.('\u200bHello 👩🏽‍💻');
                keyboard.sentinelProps.onChangeText?.('');
                keyboard.beginComposition();
                keyboard.sentinelProps.onChangeText?.('\u200bに');
                keyboard.sentinelProps.onChangeText?.('\u200b日本');
            });
            expect(sent).toEqual([{ text: 'Hello 👩🏽‍💻' }, { key: 'Backspace' }]);
            act(() => {
                keyboard.endComposition();
                // Browsers deliver the committed input event after compositionend.
                keyboard.sentinelProps.onChangeText?.('\u200b日本');
            });
            expect(sent).toHaveLength(3);
            expect(sent.at(-1)).toEqual({ text: '日本' });
            await hook.rerender({ enabled: false });
            act(() => hook.getCurrent().sentinelProps.onChangeText?.('\u200bignored'));
            expect(sent).toHaveLength(3);
            expect(hook.getCurrent().available).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('resets a React Native Web host (a DOM input without native props) back to the sentinel', async () => {
        const sent: string[] = [];
        const target: BrowserEditableTargetV1 = { editable: true, inputMode: 'text', secret: false, multiline: false };
        const hook = await renderHook(({ enabled }) => useBrowserSoftKeyboard({ enabled, target,
            sendText: text => { sent.push(text); }, sendKey: () => {} }), { initialProps: { enabled: false } });
        try {
            // The web host is the DOM input itself: focus/blur and a value, no setNativeProps.
            const host = { value: '', focus: () => {}, blur: () => {} };
            Object.assign(hook.getCurrent().inputRef, { current: host as unknown as TextInput });
            await hook.rerender({ enabled: true });
            act(() => { hook.getCurrent().sentinelProps.onChangeText?.('\u200ba'); });
            expect(sent).toEqual(['a']);
            expect(host.value).toBe('\u200b');
        } finally { await hook.unmount(); }
    });

    it('keeps a native keyboard focused across equivalent metadata snapshots', async () => {
        const calls: string[] = [];
        const target: BrowserEditableTargetV1 = { editable: true, inputMode: 'text', secret: false, multiline: false };
        const hook = await renderHook(({ enabled, target }) => useBrowserSoftKeyboard({ enabled, target,
            sendText: () => {}, sendKey: () => {} }), { initialProps: { enabled: false, target } });
        try {
            // Native TextInput is the system boundary; keyboard behavior remains real.
            Object.assign(hook.getCurrent().inputRef, { current: {
                focus: () => { calls.push('focus'); }, blur: () => { calls.push('blur'); }, setNativeProps: () => {},
            } as unknown as TextInput });
            await hook.rerender({ enabled: true, target });
            calls.length = 0;
            for (let i = 0; i < 10; i++) await hook.rerender({ enabled: true, target: { ...target } });
            expect(calls).toEqual([]);
            await hook.rerender({ enabled: false, target });
            expect(calls).toContain('blur');
        } finally { await hook.unmount(); }
    });
});
