import * as React from 'react';
import { View } from 'react-native';

import type { PopoverRenderProps } from './_types';

/**
 * A view pushed inside a phone sheet: a sheet-presented popover opened from inside the sheet (a menu
 * row's picker, a dropdown's submenu) shows here instead of opening a second sheet over it.
 */
export type PhoneSheetPushEntry = Readonly<{
    key: string;
    /** The pushed view's name in the sheet's band; absent when the content draws its own header. */
    title?: string;
    subtitle?: string;
    /** The pushed popover's own close: Back, Escape and the hardware back, and its content's close. */
    close: () => void;
    render: (renderProps: PopoverRenderProps) => React.ReactNode;
}>;

/** What the sheet's chrome draws for the top pushed view (identity changes only when these do). */
export type PhoneSheetPushChrome = Readonly<{ key: string; title?: string; subtitle?: string }>;

export type PhoneSheetPushStack = Readonly<{
    set: (entry: PhoneSheetPushEntry) => void;
    remove: (key: string) => void;
    back: () => void;
    subscribe: (listener: () => void) => () => void;
    getChrome: () => PhoneSheetPushChrome | null;
    getVersion: () => number;
    getEntries: () => readonly PhoneSheetPushEntry[];
}>;

/** One stack per phone sheet: pushed views in the order they opened, the last one shown. */
export function createPhoneSheetPushStack(): PhoneSheetPushStack {
    const entries = new Map<string, PhoneSheetPushEntry>();
    const listeners = new Set<() => void>();
    let list: readonly PhoneSheetPushEntry[] = [];
    let chrome: PhoneSheetPushChrome | null = null;
    let version = 0;
    const publish = () => {
        list = [...entries.values()];
        const top = list[list.length - 1];
        const next = top ? { key: top.key, title: top.title, subtitle: top.subtitle } : null;
        if (next?.key !== chrome?.key || next?.title !== chrome?.title || next?.subtitle !== chrome?.subtitle) chrome = next;
        version += 1;
        for (const listener of listeners) listener();
    };
    return {
        set: (entry) => {
            entries.set(entry.key, entry);
            publish();
        },
        remove: (key) => {
            if (entries.delete(key)) publish();
        },
        back: () => {
            list[list.length - 1]?.close();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getChrome: () => chrome,
        getVersion: () => version,
        getEntries: () => list,
    };
}

export const PhoneSheetPushContext = React.createContext<PhoneSheetPushStack | null>(null);

const HIDDEN = { display: 'none' } as const;

/**
 * The sheet's body: its own content, then the views pushed over it. Every view stays mounted (a pushed
 * popover lives inside the view under it); only the top one shows.
 */
export function PhoneSheetPushBody(props: Readonly<{
    stack: PhoneSheetPushStack;
    pushed: boolean;
    renderProps: PopoverRenderProps;
    children: React.ReactNode;
}>) {
    const { stack } = props;
    React.useSyncExternalStore(stack.subscribe, stack.getVersion, stack.getVersion);
    const entries = stack.getEntries();
    return (
        <PhoneSheetPushContext.Provider value={stack}>
            <View style={props.pushed ? HIDDEN : undefined}>{props.children}</View>
            {entries.map((entry, index) => (
                <View key={entry.key} style={index === entries.length - 1 ? undefined : HIDDEN}>
                    {entry.render({ ...props.renderProps, requestClose: entry.close })}
                </View>
            ))}
        </PhoneSheetPushContext.Provider>
    );
}

/**
 * A sheet-presented popover opened inside a phone sheet: it pushes its content into that sheet while
 * open and renders nothing where it stands.
 */
export function usePhoneSheetPush(input: Readonly<{
    stack: PhoneSheetPushStack;
    open: boolean;
    title?: string;
    subtitle?: string;
    onRequestClose?: () => void;
    render: (renderProps: PopoverRenderProps) => React.ReactNode;
}>): void {
    const key = React.useId();
    const { stack } = input;
    const closeRef = React.useRef(input.onRequestClose);
    closeRef.current = input.onRequestClose;
    React.useLayoutEffect(() => {
        if (!input.open) {
            stack.remove(key);
            return;
        }
        stack.set({ key, title: input.title, subtitle: input.subtitle, close: () => closeRef.current?.(), render: input.render });
    });
    React.useLayoutEffect(() => () => stack.remove(key), [stack, key]);
}
