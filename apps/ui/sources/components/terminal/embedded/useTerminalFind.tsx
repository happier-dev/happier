import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { FindBar } from '@/components/ui/find/FindBar';
import { FindBarPlacement, useFindBarPresence } from '@/components/ui/find/FindBarPlacement';
import { useFindSurfaceFocusReturn } from '@/components/ui/find/useFindSurfaceFocusReturn';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';
import { t } from '@/text';
import type { EmbeddedTerminalRendererHandle, FindEngine } from './embeddedTerminalRendererHandle';
import { readTerminalSurfaceState, updateTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';

const NO_SUBSCRIPTION = () => () => {};
/** Mount state subscribes only to open/close; query and counts stay local to the bar. */
export function useTerminalFind(props: Readonly<{ title: string; focused?: boolean; findSurfaceId?: string; nativeSurfaceKey?: string | null; terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null> }>, seatedInFlow: boolean) {
    const [engine, setEngine] = React.useState<FindEngine | null>(null);
    const handoffSubscription = React.useRef<(() => void) | null>(null);
    const rootRef = React.useRef<View | null>(null);
    const inputRef = React.useRef<TextInput | null>(null);
    const [inputFocused, setInputFocused] = React.useState(false);
    const { capture, clear, restore } = useFindSurfaceFocusReturn();
    const eligible = usePluginSurfaceFocusEligibility() && props.focused !== false;
    const eligibleRef = React.useRef(eligible); eligibleRef.current = eligible;
    const onFindEngine = React.useCallback((next: FindEngine | null) => {
        handoffSubscription.current?.(); handoffSubscription.current = null;
        const key = props.nativeSurfaceKey;
        if (next && key) {
            const seed = readTerminalSurfaceState(key)?.find;
            if (seed) {
                next.setOptions(seed.options); next.setQuery(seed.query);
                if (seed.open && eligibleRef.current) next.open();
            }
            const remember = () => {
                const { open, query, options } = next.getSnapshot();
                const saved = readTerminalSurfaceState(key)?.find;
                if (saved?.open === open && saved.query === query
                    && saved.options.regex === options.regex && saved.options.matchCase === options.matchCase) return;
                updateTerminalSurfaceState(key, current => ({ ...current, find: { open, query, options } }));
            };
            handoffSubscription.current = next.subscribe(remember);
            remember();
        }
        setEngine(next);
    }, [props.nativeSurfaceKey]);
    // Detach before the renderer's disposal closes its engine. A resize must
    // hand off user intent, not the disposed renderer's final closed snapshot.
    React.useLayoutEffect(() => () => {
        handoffSubscription.current?.(); handoffSubscription.current = null;
    }, []);
    const id = React.useId();
    const open = React.useSyncExternalStore(engine?.subscribe ?? NO_SUBSCRIPTION, () => engine?.getSnapshot().open ?? false, () => false);
    const close = React.useCallback(() => {
        engine?.close(); setInputFocused(false); restore(() => props.terminalRef.current?.focus?.());
    }, [engine, props.terminalRef, restore]);
    const controller = React.useMemo<FindController | null>(() => engine ? {
        get query() { return engine.query; }, get options() { return engine.options; }, get status() { return engine.status; },
        capabilities: engine.capabilities, setQuery: engine.setQuery, setOptions: engine.setOptions,
        step: engine.step, stop: engine.stop, close,
    } : null, [close, engine]);
    const containsFocus = () => {
        if (!eligible) return false;
        if (Platform.OS !== 'web' || inputFocused) return true;
        const root = rootRef.current as unknown as HTMLElement | null;
        return Boolean(root && typeof document !== 'undefined' && root.contains(document.activeElement));
    };
    useFindSurfaceRegistration(eligible && engine && controller ? {
        surfaceId: props.findSurfaceId ?? `terminal:${id}`, controller,
        containsTarget: target => isFindSurfaceTarget(rootRef.current as unknown as HTMLElement | null, target),
        containsFocus, isOpen: () => open, isInputFocused: () => inputFocused,
        open: () => { capture(engine.getSnapshot().open); engine.open(); inputRef.current?.focus(); },
    } : null);
    React.useEffect(() => { if (!eligible) { engine?.close(); setInputFocused(false); clear(); } }, [clear, eligible, engine]);
    const presence = useFindBarPresence(open);
    const bar = presence.present && engine && controller ? <TerminalFindBar engine={engine} controller={controller}
        title={props.title} seatedInFlow={seatedInFlow} inputRef={inputRef} visible={open}
        onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)} /> : null;
    return { open, bar, rootRef, onFindEngine };
}

function TerminalFindBar(props: Readonly<{ engine: FindEngine; controller: FindController; title: string; seatedInFlow: boolean; visible: boolean;
    inputRef: React.RefObject<TextInput | null>; onInputFocus(): void; onInputBlur(): void }>) {
    const snapshot = React.useSyncExternalStore(props.engine.subscribe, props.engine.getSnapshot, props.engine.getSnapshot);
    return <FindBarPlacement seatedInFlow={props.seatedInFlow} visible={props.visible}>{(presentation) =>
        <FindBar testID="terminal-find" surfaceLabel={t('find.surface.terminal', { name: props.title })}
            presentation={presentation} inputRef={props.inputRef}
            query={snapshot.query} options={snapshot.options} status={snapshot.status} capabilities={props.controller.capabilities}
            onQueryChange={props.controller.setQuery} onOptionsChange={props.controller.setOptions}
            onStep={props.controller.step} onStop={props.controller.stop} onClose={props.controller.close}
            onInputFocus={props.onInputFocus} onInputBlur={props.onInputBlur}
            // The retained-lines note is only for incomplete results (Find lab ST).
            note={snapshot.status.kind === 'searching' ? { icon: 'history', text: t('common.loading') }
                : snapshot.status.kind === 'results' && snapshot.status.coverage === 'limited'
                ? { icon: 'info', text: t('find.note.terminalKept', { lines: snapshot.retainedLines.toLocaleString() }) } : null} />
    }</FindBarPlacement>;
}
