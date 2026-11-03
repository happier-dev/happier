import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import type { BrowserEditableTargetV1 } from '@happier-dev/protocol';
import type { TextInput } from 'react-native';

import { useBrowserSoftKeyboard } from './useBrowserSoftKeyboard';

describe('browser viewer geometry and soft keyboard', () => {
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
