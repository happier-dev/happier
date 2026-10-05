import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { FindBar } from '@/components/ui/find/FindBar';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { t } from '@/text';
import type { EmbeddedTerminalRendererHandle, FindEngine } from './embeddedTerminalRendererHandle';

const NO_SUBSCRIPTION = () => () => {};
/** Mount state subscribes only to open/close; query and counts stay local to the bar. */
export function useTerminalFind(props: Readonly<{ title: string; focused?: boolean; findSurfaceId?: string; terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null> }>, phone: boolean) {
    const [engine, onFindEngine] = React.useState<FindEngine | null>(null);
    const rootRef = React.useRef<View | null>(null);
    const inputRef = React.useRef<TextInput | null>(null);
    const [inputFocused, setInputFocused] = React.useState(false);
    const eligible = usePluginSurfaceFocusEligibility() && props.focused !== false;
    const id = React.useId();
    const open = React.useSyncExternalStore(engine?.subscribe ?? NO_SUBSCRIPTION, () => engine?.getSnapshot().open ?? false, () => false);
    const close = React.useCallback(() => {
        engine?.close(); setInputFocused(false); props.terminalRef.current?.focus?.();
    }, [engine, props.terminalRef]);
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
        containsFocus, isOpen: () => open, isInputFocused: () => inputFocused,
        open: () => { engine.open(); inputRef.current?.focus(); },
    } : null);
    React.useEffect(() => { if (!eligible) { engine?.close(); setInputFocused(false); } }, [eligible, engine]);
    const bar = open && engine && controller ? <TerminalFindBar engine={engine} controller={controller}
        title={props.title} phone={phone} inputRef={inputRef}
        onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)} /> : null;
    return { open, bar, rootRef, onFindEngine };
}

function TerminalFindBar(props: Readonly<{ engine: FindEngine; controller: FindController; title: string; phone: boolean;
    inputRef: React.RefObject<TextInput | null>; onInputFocus(): void; onInputBlur(): void }>) {
    const snapshot = React.useSyncExternalStore(props.engine.subscribe, props.engine.getSnapshot, props.engine.getSnapshot);
    // Inline, the bar spans the pane like every Find surface (lab `.fd-bar`: 10 down, 14 in), so a narrow split
    // leaf gets the compact capsule rather than a clipped one.
    return <View pointerEvents="box-none" style={props.phone ? undefined : { position: 'absolute', left: 14, right: 14, top: 10, zIndex: 20 }}>
        <FindBar testID="terminal-find" surfaceLabel={t('find.surface.terminal', { name: props.title })}
            presentation={props.phone ? 'keyboardSeated' : 'inline'} inputRef={props.inputRef}
            query={snapshot.query} options={snapshot.options} status={snapshot.status} capabilities={props.controller.capabilities}
            onQueryChange={props.controller.setQuery} onOptionsChange={props.controller.setOptions}
            onStep={props.controller.step} onStop={props.controller.stop} onClose={props.controller.close}
            onInputFocus={props.onInputFocus} onInputBlur={props.onInputBlur}
            // Said only when the search ended at what the terminal keeps (Find lab ST), never on every result.
            note={snapshot.status.kind === 'results' && snapshot.status.coverage === 'limited'
                ? { icon: 'info', text: t('find.note.terminalKept', { lines: snapshot.retainedLines.toLocaleString() }) } : null} />
    </View>;
}
