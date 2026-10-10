import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { FindBar } from '@/components/ui/find/FindBar';
import { FindBarPlacement } from '@/components/ui/find/FindBarPlacement';
import { useFindSurfaceFocusReturn } from '@/components/ui/find/useFindSurfaceFocusReturn';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { t } from '@/text';
import { useFileViewerFind, type FileViewerFindContent, type FileViewerFindSnapshot } from './useFileViewerFind';

export function FileViewerFindSurface(props: Readonly<{
    surfaceId: string;
    active: boolean;
    content: FileViewerFindContent;
    focusRootRef?: React.RefObject<View | null>;
    findSeed?: FileFindSeed | null;
    onFindSeedConsumed?: () => void;
    children(snapshot: FileViewerFindSnapshot): React.ReactNode;
}>) {
    const model = useFileViewerFind(props.content, props.active);
    const snapshot = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
    const viewport = React.useRef<View | null>(null);
    const input = React.useRef<TextInput | null>(null);
    const focusReturn = useFindSurfaceFocusReturn();
    const [inputFocused, setInputFocused] = React.useState(false);
    const eligible = usePluginSurfaceFocusEligibility() && props.active && props.content.text !== null;
    const captureFocus = () => {
        focusReturn.capture(model.getSnapshot().open);
    };
    const open = () => { captureFocus(); model.open(); input.current?.focus(); };
    const close = () => {
        model.close(); setInputFocused(false);
        focusReturn.restore();
    };
    const controller: FindController = { get query() { return model.query; }, get options() { return model.options; },
        get status() { return model.status; }, capabilities: model.capabilities,
        setQuery: model.setQuery, setOptions: model.setOptions, step: model.step, stop: model.stop, close };
    useFindSurfaceRegistration(eligible ? {
        surfaceId: props.surfaceId,
        containsFocus: () => {
            if (Platform.OS !== 'web') return true;
            const node = (props.focusRootRef?.current ?? viewport.current) as unknown as HTMLElement | null;
            return Boolean(node && typeof document !== 'undefined' && document.activeElement && node.contains(document.activeElement));
        }, open, isOpen: () => model.getSnapshot().open, isInputFocused: () => inputFocused, controller,
    } : null);
    React.useEffect(() => {
        if (!props.active || !props.findSeed) return;
        captureFocus();
        if (model.applySeed(props.findSeed)) props.onFindSeedConsumed?.();
    }, [model, props.active, props.content.mode, props.content.text, props.findSeed, props.onFindSeedConsumed]);
    const bar = snapshot.open && props.active ? <FindBarPlacement>{(presentation) => <FindBar
        query={snapshot.query} options={snapshot.options} status={snapshot.status} capabilities={model.capabilities}
        surfaceLabel={t('find.surface.file')} presentation={presentation} autoFocus inputRef={input}
        onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)}
        onQueryChange={model.setQuery} onOptionsChange={model.setOptions} onStep={model.step}
        note={snapshot.status.kind === 'searching' ? { icon: 'history', text: t('common.loading') } : undefined}
        onStop={model.stop} onClose={close} testID="file-viewer-find" />}</FindBarPlacement> : null;
    return <View ref={viewport} testID="file-viewer-find-surface" tabIndex={-1} style={{ flex: 1, minHeight: 0 }}>
        {props.children(snapshot)}
        {bar}
    </View>;
}
