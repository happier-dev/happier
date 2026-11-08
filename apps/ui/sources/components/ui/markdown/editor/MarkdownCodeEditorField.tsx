import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CodeEditorWithFind } from '@/components/ui/code/editor/CodeEditorWithFind';
import type { CodeEditorProps, EditorDocumentHistory, TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { createEditorDocumentHistory } from '@/components/ui/code/editor/editorDocumentHistory';
import type { EditorChangeMarkerSeed } from '@/components/ui/code/editor/editorChangeMarkers';
import type { EditorChangeMarkersController } from '@/components/ui/code/editor/useEditorChangeMarkers';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { RichMarkdownEditorPanel } from '@/components/ui/markdown/editor/RichMarkdownEditorPanel';
import { useMarkdownEditMode } from '@/components/ui/markdown/editor/useMarkdownEditMode';
import { useMarkdownLiveValue, type MarkdownLiveValueStore } from './useMarkdownLiveValue';
import { Text } from '@/components/ui/text/Text';
import type { MarkdownEditorController } from '@/components/ui/markdown/editor/markdownEditorTypes';
import { MarkdownEditModeMenu } from '@/components/ui/markdown/editorChrome/MarkdownEditModeMenu';
import { MarkdownEditorToolbar } from '@/components/ui/markdown/editorChrome/MarkdownEditorToolbar';
import {
    CodeEditorAccessoryBar,
    EditorAccessoryHideKeyboardKey,
    EditorAccessorySaveKey,
    type CodeEditorAccessoryBarProps,
} from '@/components/ui/code/editor/chrome/CodeEditorAccessoryBar';
import { EditorAccessoryBar } from '@/components/ui/code/editor/chrome/EditorAccessoryBar';

/**
 * Reusable drop-in replacement for `CodeEditor` on markdown-capable screens
 * (Lane A). It owns the Raw <-> Rich edit-mode toggle (gated by the
 * `files.markdownRichEditor` feature flag, the `markdownDefaultEditMode` setting,
 * and the eligibility gate) and renders the matching surface beneath a compact
 * header.
 *
 * The host's `value`/`onChange` are the single source of truth (typically React
 * state the parent also saves from). A single internal `editorHandleRef` is
 * forwarded to BOTH the active surface and the parent's optional `editorRef`, so
 * the parent can `await editorRef.current?.flushPendingChange()` before reading
 * its state on save (capturing the latest rich/raw edit before persistence).
 *
 * Language resolution: explicit `language` wins; otherwise it is derived from
 * `filePath` via `getFileLanguageFromPath`. Rich is offered ONLY when the
 * resolved language is `'markdown'` (so non-`.md` files fall back to raw with
 * their real syntax highlighting).
 */

export type MarkdownCodeEditorFieldProps = Readonly<{
    value: string;
    onChange: CodeEditorProps['onChange'];
    history?: EditorDocumentHistory;
    resetKey: string;
    filePath?: string;
    language?: string | null;
    editorRef?: React.Ref<TextEditorHandle>;
    readOnly?: boolean;
    /** Empty-document hint shared by the raw and rich surfaces; never part of the document. */
    placeholder?: string;
    /** Accessible name of the empty-document hint. */
    accessibilityLabel?: string;
    /**
     * Soft-wrap long lines in the RAW editor (ignored in rich mode, which always
     * wraps). Defaults to `true` since markdown is prose; screens that expose a
     * user wrap setting (e.g. `wrapLinesInDiffs`) should forward it here so that
     * behavior is preserved.
     */
    wrapLines?: boolean;
    /** `canvas`: the document's source is the page (an Artifact), unframed on the page's surface. Default framed. */
    presentation?: 'framed' | 'canvas';
    /** The source only, with no rich mode and no mode menu: for a page that offers its own Preview (a skill's instructions). */
    sourceOnly?: boolean;
    testID?: string;
    liveValue?: MarkdownLiveValueStore;
    findSurfaceId?: string;
    active?: boolean;
    focusRootRef?: React.RefObject<React.ElementRef<typeof View> | null>;
    findSeed?: FileFindSeed | null;
    onFindSeedConsumed?: () => void;
    showLineNumbers?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
    onReady?: () => void;
    initialLine?: number;
    lineNumberDigits?: number;
    reviewLaneWidth?: number;
    changeMarkers?: EditorChangeMarkerSeed;
    onChangeMarkersChange?: (controller: EditorChangeMarkersController | null) => void;
    /** The raw source editor's handle (null in rich mode), for a host that hangs UI from its lines (the change peek). */
    onEditorHandleChange?: (handle: TextEditorHandle | null) => void;
    /**
     * Phone composition (files lab ED1mp): the one key row on the keyboard with Save pinned. Rich mode puts
     * its formatting chips there (instead of the field header); raw mode gets the code editor's key row, with the
     * page's language-intelligence port (Suggest / Expand / Shrink) as it has for code.
     */
    accessory?: Pick<CodeEditorAccessoryBarProps, 'save' | 'languageIntelligence'> | null;
}>;

const TOOLBAR_SLOT_STYLE = { flex: 1, minWidth: 0, overflow: 'hidden' } as const;
const MODE_MENU_SLOT_STYLE = { flexShrink: 0 } as const;

export function MarkdownCodeEditorField(props: MarkdownCodeEditorFieldProps) {
    // A standalone field owns its document lifetime. File pages pass their existing buffer's history.
    const localHistory = React.useMemo(() => createEditorDocumentHistory(), [props.resetKey]);
    const localText = React.useRef(props.value);
    React.useEffect(() => {
        if (localText.current !== props.value) { localText.current = props.value; localHistory.reset(); }
    }, [localHistory, props.value]);
    const onChange = React.useCallback<CodeEditorProps['onChange']>((next, change) => {
        if (!props.history && !change?.history) localHistory.record(localText.current, next);
        localText.current = next;
        if (change) props.onChange(next, change);
        else props.onChange(next);
    }, [localHistory, props.history, props.onChange]);
    const history = props.history ?? localHistory;
    // Explicit language wins; otherwise derive from the file path (markdown for
    // `.md`, the file's real language otherwise so raw mode highlights correctly).
    const language = React.useMemo(() => {
        if (props.language !== undefined) return props.language;
        return props.filePath ? getFileLanguageFromPath(props.filePath) : null;
    }, [props.language, props.filePath]);

    // Single handle wired to the active surface and forwarded to the parent ref,
    // so both the field (mode toggle) and the parent (save) can flush — in BOTH
    // raw and rich modes. `RichMarkdownEditorPanel` assigns to `editorHandleRef`
    // via `.current =`, while the raw `CodeEditor` uses a callback ref; both must
    // land in the parent ref too. We use a single forwarding ref object whose
    // `current` setter mirrors into the (latest) parent ref — held in a ref so the
    // forwarding object stays stable across renders even as `props.editorRef`
    // changes identity.
    const parentRefHolder = React.useRef(props.editorRef);
    parentRefHolder.current = props.editorRef;

    const editorHandleRef = React.useMemo<React.MutableRefObject<TextEditorHandle | null>>(() => {
        let value: TextEditorHandle | null = null;
        const assignParent = (handle: TextEditorHandle | null) => {
            const parentRef = parentRefHolder.current;
            if (typeof parentRef === 'function') {
                parentRef(handle);
            } else if (parentRef && typeof parentRef === 'object') {
                parentRef.current = handle;
            }
        };
        return {
            get current() {
                return value;
            },
            set current(handle: TextEditorHandle | null) {
                value = handle;
                assignParent(handle);
            },
        };
    }, []);

    const {
        seedText,
        showRich: richModeVisible,
        markdownEditMode,
        richEligible,
        richEligibilityPending,
        richDisabledReason,
        resetKey,
        showToggle,
        onToggle,
        onUnavailable,
    } = useMarkdownEditMode({
        value: props.value,
        language,
        baseResetKey: props.resetKey,
        editorHandleRef,
        onValueChange: onChange,
        liveValue: props.liveValue,
        active: props.active,
    });

    const showRich = props.sourceOnly !== true && richModeVisible;

    // Live controller of the embedded rich surface — set when the rich panel
    // mounts, cleared when it unmounts (or when we switch to raw). Drives the
    // inline header toolbar so prompt-editor screens see formatting affordances
    // close to the field header, instead of a footer toolbar way below on long
    // documents.
    const [richController, setRichController] = React.useState<MarkdownEditorController | null>(null);
    // The callback identity must be stable — `RichMarkdownEditorPanel` wires it
    // into a mount/unmount effect, and re-firing it on every parent re-render
    // would publish / clear the controller spuriously.
    const handleRichControllerChange = React.useCallback((controller: MarkdownEditorController | null) => {
        setRichController(controller);
    }, []);

    // Inline toolbar lives in the header (left of the dropdown) ONLY when rich
    // mode is actually rendering AND we have a controller. Raw mode leaves the
    // slot empty: showing format chips while raw is displayed would be misleading
    // (they'd dispatch into a hidden surface) and the field has no toolbar to
    // offer for plain code editing.
    const accessory = props.readOnly === true ? null : props.accessory ?? null;
    const showInlineToolbar = showRich && richController !== null && props.readOnly !== true && accessory === null;
    // The raw surface's live handle drives the key row's history (Undo) and its commands.
    const [rawHandle, setRawHandle] = React.useState<TextEditorHandle | null>(null);
    const onHostHandleChange = props.onEditorHandleChange;
    const onRawHandleChange = React.useCallback((handle: TextEditorHandle | null) => {
        const raw = showRich ? null : handle;
        setRawHandle(raw);
        onHostHandleChange?.(raw);
    }, [onHostHandleChange, showRich]);
    const accessoryTestID = props.testID ? `${props.testID}-accessory` : 'markdown-editor-accessory';
    const keyRow = accessory === null ? null
        : !showRich ? <CodeEditorAccessoryBar editor={rawHandle} save={accessory.save} languageIntelligence={accessory.languageIntelligence} testID={accessoryTestID} />
        : richController ? (
            <MarkdownEditorToolbar controller={richController} variant="panel" testID={accessoryTestID}
                leading={<EditorAccessoryHideKeyboardKey testID={accessoryTestID} />}
                trailing={<EditorAccessorySaveKey testID={accessoryTestID} save={accessory.save} />} />
        ) : (
            // Save stays in reach while the rich surface is still coming up.
            <EditorAccessoryBar testID={accessoryTestID}
                leading={<EditorAccessoryHideKeyboardKey testID={accessoryTestID} />}
                trailing={<EditorAccessorySaveKey testID={accessoryTestID} save={accessory.save} />}>{null}</EditorAccessoryBar>
        );

    return (
        <View style={{ flex: 1 }} testID={props.testID}>
            {showToggle && props.sourceOnly !== true ? (
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        // Toolbar takes the leftmost flexible space; dropdown stays
                        // pinned to the right and visible at any container width.
                        justifyContent: 'flex-end',
                        gap: 8,
                        // On the canvas the toggle keeps the text's edge; inside a section it keeps the box's inset.
                        paddingHorizontal: props.presentation === 'canvas' ? 0 : 12,
                        paddingTop: 8,
                        paddingBottom: 4,
                    }}
                >
                    {showInlineToolbar && richController ? (
                        <View style={TOOLBAR_SLOT_STYLE}>
                        <MarkdownEditorToolbar
                            controller={richController}
                            variant="inline"
                            testID={props.testID ? `${props.testID}-inline-toolbar` : 'markdown-code-editor-field-inline-toolbar'}
                        />
                        </View>
                    ) : (
                        // Empty flexible spacer keeps the dropdown right-aligned
                        // and the header height stable across mode switches.
                        <View style={{ flex: 1 }} />
                    )}
                    {/* The mode menu keeps its width; the chips scroll (and clip) beside it on a narrow column. */}
                    <View style={MODE_MENU_SLOT_STYLE}>
                        <MarkdownEditModeMenu
                            mode={markdownEditMode}
                            onChange={(next) => { void onToggle(next); }}
                            richEligible={richEligible}
                            richDisabledReason={richDisabledReason}
                        />
                    </View>
                </View>
            ) : null}
            <View style={{ flex: 1 }}>
                {props.sourceOnly !== true && markdownEditMode === 'rich' && richEligibilityPending && !showRich ? (
                    <ActivitySpinner size="small" />
                ) : (
                    <CodeEditorWithFind
                        editorRef={editorHandleRef}
                        resetKey={resetKey}
                        value={seedText}
                        language={language}
                        onChange={onChange}
                        history={history}
                        readOnly={props.readOnly}
                        wrapLines={props.wrapLines ?? true}
                        showLineNumbers={props.showLineNumbers ?? false}
                        filePath={props.filePath}
                        surfaceId={props.findSurfaceId}
                        active={props.active}
                        focusRootRef={props.focusRootRef}
                        findSeed={props.findSeed}
                        onFindSeedConsumed={props.onFindSeedConsumed}
                        changeMarkers={props.changeMarkers}
                        onChangeMarkersChange={props.onChangeMarkersChange}
                        onEditorHandleChange={accessory || onHostHandleChange ? onRawHandleChange : undefined}
                        changeDebounceMs={props.changeDebounceMs}
                        bridgeMaxChunkBytes={props.bridgeMaxChunkBytes}
                        onReady={props.onReady}
                        initialLine={props.initialLine}
                        lineNumberDigits={props.lineNumberDigits}
                        reviewLaneWidth={props.reviewLaneWidth}
                        presentation={props.presentation}
                        testID={props.testID ? `${props.testID}:source` : undefined}
                        renderEditor={showRich ? (publishHandle) => <RichMarkdownEditorPanel
                            resetKey={resetKey}
                            editorRef={editorHandleRef}
                            onEditorHandleChange={publishHandle}
                            value={seedText}
                            onChange={onChange}
                            history={history}
                            onUnavailable={onUnavailable}
                            readOnly={props.readOnly}
                            changeDebounceMs={props.changeDebounceMs}
                            bridgeMaxChunkBytes={props.bridgeMaxChunkBytes}
                            hideFooterToolbar
                            presentation={props.presentation}
                            onControllerChange={handleRichControllerChange}
                        /> : undefined}
                    />
                )}
                {props.placeholder && !props.readOnly ? (
                    <MarkdownFieldPlaceholder value={seedText} liveValue={props.liveValue} active={props.active}
                        placeholder={props.placeholder} accessibilityLabel={props.accessibilityLabel}
                        testID={props.testID ? `${props.testID}:placeholder` : undefined} />
                ) : null}
            </View>
            {keyRow}
        </View>
    );
}

/** Only the hint reads live file-buffer updates; the host keeps the editor's existing seed lifetime. */
function MarkdownFieldPlaceholder(props: Readonly<{
    value: string;
    liveValue?: MarkdownLiveValueStore;
    active?: boolean;
    placeholder: string;
    accessibilityLabel?: string;
    testID?: string;
}>) {
    const value = useMarkdownLiveValue(props.value, props.liveValue, props.active);
    const { theme } = useUnistyles();
    if (value.length > 0) return null;
    return (
        <Text variant="body" pointerEvents="none" testID={props.testID}
            accessibilityLabel={props.accessibilityLabel} accessibilityHint={props.placeholder}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, color: theme.colors.text.tertiary }}>
            {props.placeholder}
        </Text>
    );
}
