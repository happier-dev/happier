import * as React from 'react';
import type { TextInput, TextInputProps } from 'react-native';
import type { BrowserEditableTargetV1 } from '@happier-dev/protocol';

// A real editable host is needed to summon mobile keyboards. The sentinel lets a
// backspace at the start still produce a native text change without reading the page.
const SENTINEL = '\u200b';

type SentinelHost = TextInput & Readonly<{ setNativeProps?: (props: Readonly<{ text: string }>) => void }>;

/** Native hosts take the sentinel through native props; React Native Web's host is the DOM input itself. */
function writeSentinel(host: SentinelHost | null): void {
    if (!host) return;
    if (typeof host.setNativeProps === 'function') host.setNativeProps({ text: SENTINEL });
    else if ('value' in host) (host as unknown as { value: string }).value = SENTINEL;
}

/** Behavior for the UI lane's hidden TextInput; all text uses the existing viewer input relay. */
export function useBrowserSoftKeyboard(input: Readonly<{
    enabled: boolean;
    target: BrowserEditableTargetV1 | null;
    /** Computer viewers summon the keyboard explicitly, without browser editable metadata. */
    manual?: boolean;
    sendText(text: string): void;
    sendKey(key: string): void;
}>) {
    const inputRef = React.useRef<TextInput>(null);
    const composing = React.useRef(false);
    const pendingComposition = React.useRef('');
    const justCommitted = React.useRef<string | null>(null);
    const [focused, setFocused] = React.useState(false);
    const available = input.enabled && (input.manual === true || input.target?.editable === true && input.target.inputMode !== 'none');
    const availableRef = React.useRef(available);
    availableRef.current = available;
    const callbacks = React.useRef(input);
    callbacks.current = input;

    const reset = React.useCallback(() => {
        composing.current = false;
        pendingComposition.current = '';
        justCommitted.current = null;
        writeSentinel(inputRef.current);
    }, []);
    const showKeyboard = React.useCallback(() => { if (availableRef.current) inputRef.current?.focus(); }, []);
    const hideKeyboard = React.useCallback(() => { inputRef.current?.blur(); reset(); }, [reset]);

    React.useEffect(() => {
        if (!available) hideKeyboard();
        else if (!input.manual) showKeyboard();
        return hideKeyboard;
    }, [available, input.manual, input.target?.editable && input.target.inputMode, input.target?.editable && input.target.multiline,
        input.target?.editable && input.target.secret, hideKeyboard, showKeyboard]);

    const onChangeText = React.useCallback((text: string) => {
        if (!availableRef.current) { reset(); return; }
        if (composing.current) { pendingComposition.current = text; return; }
        const previousCommit = justCommitted.current;
        justCommitted.current = null;
        if (previousCommit !== null && (text === previousCommit || text === SENTINEL)) { reset(); return; }
        if (!text) callbacks.current.sendKey('Backspace');
        else {
            const committed = text.startsWith(SENTINEL) ? text.slice(SENTINEL.length) : text;
            if (committed) callbacks.current.sendText(committed);
        }
        reset();
    }, [reset]);

    // Web hosts wire their composition events here. Candidate text is never relayed.
    const beginComposition = React.useCallback(() => {
        composing.current = true; pendingComposition.current = ''; justCommitted.current = null;
    }, []);
    const endComposition = React.useCallback((text?: string) => {
        const committed = text ?? pendingComposition.current;
        composing.current = false;
        if (committed) { onChangeText(committed); justCommitted.current = committed; }
        else reset();
    }, [onChangeText, reset]);

    const target = input.target?.editable ? input.target : null;
    const sentinelProps: TextInputProps = {
        defaultValue: SENTINEL,
        editable: available,
        inputMode: target?.inputMode ?? 'text',
        multiline: target?.multiline ?? false,
        secureTextEntry: target?.secret ?? false,
        autoCorrect: target ? !target.secret : false,
        autoComplete: 'off',
        onChangeText,
        onFocus: () => setFocused(true),
        onBlur: () => { setFocused(false); reset(); },
        onSubmitEditing: () => { if (availableRef.current) callbacks.current.sendKey('Enter'); },
    };
    return { inputRef, sentinelProps, available, focused, showKeyboard, hideKeyboard, beginComposition, endComposition };
}
