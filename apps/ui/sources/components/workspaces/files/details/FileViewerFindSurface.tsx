import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { FindBar } from '@/components/ui/find/FindBar';
import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { readDocumentFocusReturnTarget, restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { useDeviceType } from '@/utils/platform/responsive';
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
    const returnFocus = React.useRef<FocusReturnTarget>(null);
    const [inputFocused, setInputFocused] = React.useState(false);
    const eligible = usePluginSurfaceFocusEligibility() && props.active && props.content.text !== null;
    const phone = useDeviceType() === 'phone';
    const captureFocus = () => {
        if (!model.getSnapshot().open) returnFocus.current = Platform.OS === 'web' && typeof document !== 'undefined'
            ? readDocumentFocusReturnTarget(document) : TextInput.State.currentlyFocusedInput();
    };
    const open = () => { captureFocus(); model.open(); input.current?.focus(); };
    const close = () => {
        model.close(); setInputFocused(false);
        restoreFocusToBestTarget(returnFocus); returnFocus.current = null;
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
    const bar = snapshot.open && props.active ? <FindBar
        query={snapshot.query} options={snapshot.options} status={snapshot.status} capabilities={model.capabilities}
        surfaceLabel={t('find.surface.file')} presentation={phone ? 'keyboardSeated' : 'inline'} autoFocus inputRef={input}
        onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)}
        onQueryChange={model.setQuery} onOptionsChange={model.setOptions} onStep={model.step}
        onStop={model.stop} onClose={close} testID="file-viewer-find" /> : null;
    return <View ref={viewport} testID="file-viewer-find-surface" tabIndex={-1} style={{ flex: 1, minHeight: 0 }}>
        {props.children(snapshot)}
        {phone ? <ComposerKeyboardFloatingInset baseBottom={8} style={{ position: 'absolute', left: 8, right: 8 }}>{bar}</ComposerKeyboardFloatingInset>
            : <View pointerEvents="box-none" style={{ position: 'absolute', top: 10, left: 14, right: 14 }}>{bar}</View>}
    </View>;
}
