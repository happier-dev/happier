import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';

import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { usePublishCodeEditorHandle } from '@/components/ui/code/editor/usePublishCodeEditorHandle';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import type { CodeEditorFindHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { FindBar } from '@/components/ui/find/FindBar';
import { FindBarPlacement } from '@/components/ui/find/FindBarPlacement';
import { useFindSurfaceFocusReturn } from '@/components/ui/find/useFindSurfaceFocusReturn';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';

function FileEditorPanelImpl(props: Readonly<{
    theme: any;
    resetKey: string;
    editorRef: Readonly<React.MutableRefObject<CodeEditorHandle | null>>;
    value: string;
    filePath?: string;
    surfaceId?: string;
    active?: boolean;
    focusRootRef?: React.RefObject<React.ElementRef<typeof View> | null>;
    findSeed?: FileFindSeed | null;
    onFindSeedConsumed?: () => void;
    language: string | null;
    onChange: (next: string) => void;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    readOnly?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
}>) {
    const [handle, setHandle] = React.useState<CodeEditorHandle | null>(null);
    const publishEditorHandle = usePublishCodeEditorHandle(props.editorRef, setHandle);
    const find = handle?.find;
    const eligible = usePluginSurfaceFocusEligibility() && props.active !== false;
    const localRootRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const inputRef = React.useRef<TextInput | null>(null);
    const { capture, clear, restore } = useFindSurfaceFocusReturn();
    const [sharedOpen, setSharedOpen] = React.useState(false);
    const [inputFocused, setInputFocused] = React.useState(false);
    const close = React.useCallback(() => {
        find?.close();
        setSharedOpen(false);
        setInputFocused(false);
        restore(() => props.editorRef.current?.focus?.());
    }, [find, props.editorRef, restore]);
    const open = React.useCallback(() => {
        if (!find || !eligible) return;
        capture(find.isOpen());
        find.open();
        if (find.presentation === 'shared') { setSharedOpen(true); inputRef.current?.focus(); }
    }, [capture, eligible, find]);
    const controller = React.useMemo<FindController | null>(() => find ? {
        get query() { return find.getSnapshot().query; },
        get options() { return find.getSnapshot().options; },
        get status() { return find.getSnapshot().status; },
        capabilities: { regex: true, stop: false },
        setQuery: (query) => find.set(query, find.getSnapshot().options),
        setOptions: (options) => find.set(find.getSnapshot().query, options),
        step: find.step, stop: () => {}, close,
    } : null, [close, find]);
    useFindSurfaceRegistration(eligible && find && controller ? {
        surfaceId: props.surfaceId ?? props.resetKey,
        engineOwnsFind: find.presentation === 'native',
        containsFocus: () => {
            if (find.containsFocus() || inputFocused) return true;
            if (Platform.OS !== 'web' || typeof document === 'undefined') return false;
            const root = (props.focusRootRef ?? localRootRef).current as unknown as HTMLElement | null;
            return root?.contains(document.activeElement) === true;
        },
        open,
        isOpen: () => find.presentation === 'native' ? find.isOpen() : sharedOpen,
        isInputFocused: () => find.presentation === 'native' ? find.isInputFocused() : inputFocused,
        controller,
    } : null);
    const previousResetKey = React.useRef(props.resetKey);
    React.useEffect(() => {
        if (previousResetKey.current !== props.resetKey) {
            find?.close();
            setSharedOpen(false);
            setInputFocused(false);
            clear();
            previousResetKey.current = props.resetKey;
        }
    }, [clear, find, props.resetKey]);
    React.useEffect(() => {
        const seed = props.findSeed;
        if (!eligible || !find || !seed || !props.filePath || seed.target.path !== props.filePath) return;
        const anchor = seed.target.anchor;
        const line = anchor ? (anchor.kind === 'line' ? anchor.line : anchor.startLine) : undefined;
        open();
        // The facet owns pending engine boot; accepting the seed cannot lose it before ready.
        find.seed(seed.query, seed.options, line === undefined ? undefined : { line });
        props.onFindSeedConsumed?.();
    }, [eligible, find, open, props.filePath, props.findSeed, props.onFindSeedConsumed]);
    React.useEffect(() => {
        if (!eligible && sharedOpen) {
            find?.close();
            setSharedOpen(false);
            setInputFocused(false);
            clear();
        }
    }, [clear, eligible, find, sharedOpen]);
    return (
        <View ref={localRootRef} style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 12 }}>
            <CodeEditor
                ref={publishEditorHandle}
                resetKey={props.resetKey}
                value={props.value}
                language={props.language}
                onChange={props.onChange}
                testID="file-details-editor"
                wrapLines={props.wrapLines}
                showLineNumbers={props.showLineNumbers}
                readOnly={props.readOnly}
                changeDebounceMs={props.changeDebounceMs}
                bridgeMaxChunkBytes={props.bridgeMaxChunkBytes}
            />
            {eligible && sharedOpen && find?.presentation === 'shared' && controller ?
                <FileEditorFindBar find={find} controller={controller} inputRef={inputRef}
                    onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)} /> : null}
            <Text style={{ marginTop: 8, color: props.theme.colors.text.secondary, ...Typography.rowMeta() }}>
                {t('files.fileEditor.experimentalHint')}
            </Text>
        </View>
    );
}

export const FileEditorPanel = React.memo(FileEditorPanelImpl);

/** Only the open bar subscribes to query/count updates; editing and the pane do not. */
function FileEditorFindBar(props: Readonly<{
    find: CodeEditorFindHandle;
    controller: FindController;
    inputRef: React.RefObject<TextInput | null>;
    onInputFocus(): void;
    onInputBlur(): void;
}>) {
    const snapshot = React.useSyncExternalStore(props.find.subscribe, props.find.getSnapshot, props.find.getSnapshot);
    return <FindBarPlacement>{(presentation) => <FindBar query={snapshot.query} options={snapshot.options} status={snapshot.status}
        capabilities={props.controller.capabilities} surfaceLabel={t('find.surface.file')}
        presentation={presentation} inputRef={props.inputRef} autoFocus
        onInputFocus={props.onInputFocus} onInputBlur={props.onInputBlur}
        onQueryChange={props.controller.setQuery} onOptionsChange={props.controller.setOptions}
        note={snapshot.status.kind === 'searching' ? { icon: 'history', text: t('common.loading') } : undefined}
        onStep={props.controller.step} onStop={props.controller.stop} onClose={props.controller.close}
        testID="file-editor-find" />}</FindBarPlacement>;
}
