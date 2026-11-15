import * as React from 'react';
import { View } from 'react-native';

import { StepTransitionFrame, type StepTransitionDirection } from '@/components/ui/motion/StepTransitionFrame';

import type { PopoverRenderProps } from './_types';
import { PhonePushedViewContext } from './phonePushedView';

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

const SHEET_ROOT_KEY = 'phone-sheet-root';

/**
 * The sheet's body: its own content, then the views pushed over it. Every view stays mounted (a pushed
 * popover lives inside the view under it); only the top one shows. Moving between them is the app's
 * routine step transition (`StepTransitionFrame`): a push enters from the trailing edge, Back leaves
 * toward it, and reduced motion cross-fades.
 */
export function PhoneSheetPushBody(props: Readonly<{
    stack: PhoneSheetPushStack;
    renderProps: PopoverRenderProps;
    children: React.ReactNode;
}>) {
    const { stack } = props;
    React.useSyncExternalStore(stack.subscribe, stack.getVersion, stack.getVersion);
    const layers = [
        { key: SHEET_ROOT_KEY, children: props.children },
        ...stack.getEntries().map((entry) => ({
            key: entry.key,
            children: entry.render({ ...props.renderProps, requestClose: entry.close }),
        })),
    ];
    const top = layers[layers.length - 1]!;
    // A deeper stack is a push (forward), a shallower one a pop (backward).
    const transitionRef = React.useRef<Readonly<{ key: string; depth: number; direction: StepTransitionDirection }>>(
        { key: top.key, depth: layers.length, direction: 'replace' },
    );
    if (transitionRef.current.key !== top.key) {
        transitionRef.current = {
            key: top.key,
            depth: layers.length,
            direction: layers.length >= transitionRef.current.depth ? 'forward' : 'backward',
        };
    }
    return (
        <PhoneSheetPushContext.Provider value={stack}>
            <StepTransitionFrame
                testID="popover-sheet.push"
                transitionKey={top.key}
                direction={transitionRef.current.direction}
                retainedLayers={layers}
            >
                {top.children}
            </StepTransitionFrame>
        </PhoneSheetPushContext.Provider>
    );
}

const PUSHED_UNDER = { display: 'none' } as const;
/** The anchored phone popover's own content wrapper (hidden while a view is pushed over it). */
export const ANCHORED_PHONE_PUSH_ROOT_TEST_ID = 'popover-push.root';

/**
 * The body of an anchored popover on a phone: its own content, or the view pushed over it. A phone popover
 * spans the screen, so a row's picker or submenu replaces the content in place instead of hanging beside
 * it. The content stays mounted (the pushed popover lives inside it) and comes back on Back; the pushed
 * content's floating surface draws that Back (`PhonePushedViewContext`).
 */
export function AnchoredPhonePushHost(props: Readonly<{
    renderProps: PopoverRenderProps;
    children: React.ReactNode;
}>) {
    const [stack] = React.useState(createPhoneSheetPushStack);
    React.useSyncExternalStore(stack.subscribe, stack.getVersion, stack.getVersion);
    const entries = stack.getEntries();
    const top = entries[entries.length - 1];
    return (
        <PhoneSheetPushContext.Provider value={stack}>
            <View testID={ANCHORED_PHONE_PUSH_ROOT_TEST_ID} style={top ? PUSHED_UNDER : undefined}>{props.children}</View>
            {/* Every pushed view stays mounted, as in a sheet: a view pushed from inside another lives in it, so
                hiding the one under it must not unmount the push. Only the top one shows. */}
            {entries.map(entry => <AnchoredPushedView key={entry.key} entry={entry} shown={entry === top}
                renderProps={props.renderProps} />)}
        </PhoneSheetPushContext.Provider>
    );
}

/**
 * One pushed view of an anchored phone popover: named beside its own Back, hidden while another is over it.
 * Memoized on its entry: a view pushed from inside it re-publishes the stack on every render, and the view
 * under it must not re-render (and re-push) for that, only when its own entry or visibility changes.
 */
const AnchoredPushedView = React.memo(function AnchoredPushedView(props: Readonly<{ entry: PhoneSheetPushEntry; shown: boolean; renderProps: PopoverRenderProps }>) {
    const { entry } = props;
    const pushedView = React.useMemo(() => ({ title: entry.title, back: entry.close }), [entry.title, entry.close]);
    return (
        <PhonePushedViewContext.Provider value={pushedView}>
            <View testID="popover-push.view" style={props.shown ? undefined : PUSHED_UNDER}>
                {/* Its Back row names the view, as a sheet's band does, so the content drops its own title. */}
                {entry.render({ ...props.renderProps, presentation: 'sheet', pushesSubmenus: true, requestClose: entry.close })}
            </View>
        </PhonePushedViewContext.Provider>
    );
});

/**
 * A popover opened inside a phone sheet or phone popover that pushes (`phonePresentation` set): it pushes
 * its content into that host while open and renders nothing where it stands.
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
    // One close for the entry's life: its content receives it as `requestClose`, and a retained popover body
    // (Popover) would otherwise be republished by every push.
    const [close] = React.useState(() => () => closeRef.current?.());
    React.useLayoutEffect(() => {
        if (!input.open) {
            stack.remove(key);
            return;
        }
        stack.set({ key, title: input.title, subtitle: input.subtitle, close, render: input.render });
    });
    React.useLayoutEffect(() => () => stack.remove(key), [stack, key]);
}
