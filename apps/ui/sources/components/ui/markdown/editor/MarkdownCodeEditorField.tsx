import * as React from 'react';
import { View } from 'react-native';

import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { RichMarkdownEditorPanel } from '@/components/ui/markdown/editor/RichMarkdownEditorPanel';
import { useMarkdownEditMode } from '@/components/ui/markdown/editor/useMarkdownEditMode';
import type { MarkdownEditorController } from '@/components/ui/markdown/editor/markdownEditorTypes';
import { MarkdownEditModeMenu } from '@/components/ui/markdown/editorChrome/MarkdownEditModeMenu';
import { MarkdownEditorToolbar } from '@/components/ui/markdown/editorChrome/MarkdownEditorToolbar';

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
    onChange: (next: string) => void;
    resetKey: string;
    filePath?: string;
    language?: string | null;
    editorRef?: React.Ref<CodeEditorHandle>;
    readOnly?: boolean;
    /**
     * Soft-wrap long lines in the RAW editor (ignored in rich mode, which always
     * wraps). Defaults to `true` since markdown is prose; screens that expose a
     * user wrap setting (e.g. `wrapLinesInDiffs`) should forward it here so that
     * behavior is preserved.
     */
    wrapLines?: boolean;
    testID?: string;
}>;

export function MarkdownCodeEditorField(props: MarkdownCodeEditorFieldProps) {
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

    const editorHandleRef = React.useMemo<React.MutableRefObject<CodeEditorHandle | null>>(() => {
        let value: CodeEditorHandle | null = null;
        const assignParent = (handle: CodeEditorHandle | null) => {
            const parentRef = parentRefHolder.current;
            if (typeof parentRef === 'function') {
                parentRef(handle);
            } else if (parentRef && typeof parentRef === 'object') {
                (parentRef as React.MutableRefObject<CodeEditorHandle | null>).current = handle;
            }
        };
        return {
            get current() {
                return value;
            },
            set current(handle: CodeEditorHandle | null) {
                value = handle;
                assignParent(handle);
            },
        };
    }, []);

    // Callback ref for the raw `CodeEditor` (which uses an imperative-handle ref).
    const setEditorHandle = React.useCallback((handle: CodeEditorHandle | null) => {
        editorHandleRef.current = handle;
    }, [editorHandleRef]);

    const {
        markdownEditMode,
        richEligible,
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
        onValueChange: props.onChange,
    });

    const showRich = markdownEditMode === 'rich' && richEligible;

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
    const showInlineToolbar = showRich && richController !== null && props.readOnly !== true;

    return (
        <View style={{ flex: 1 }} testID={props.testID}>
            {showToggle ? (
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        // Toolbar takes the leftmost flexible space; dropdown stays
                        // pinned to the right and visible at any container width.
                        justifyContent: 'flex-end',
                        gap: 8,
                        paddingHorizontal: 12,
                        paddingTop: 8,
                        paddingBottom: 4,
                    }}
                >
                    {showInlineToolbar && richController ? (
                        <MarkdownEditorToolbar
                            controller={richController}
                            variant="inline"
                            testID={props.testID ? `${props.testID}-inline-toolbar` : 'markdown-code-editor-field-inline-toolbar'}
                        />
                    ) : (
                        // Empty flexible spacer keeps the dropdown right-aligned
                        // and the header height stable across mode switches.
                        <View style={{ flex: 1 }} />
                    )}
                    <MarkdownEditModeMenu
                        mode={markdownEditMode}
                        onChange={(next) => { void onToggle(next); }}
                        richEligible={richEligible}
                        richDisabledReason={richDisabledReason}
                    />
                </View>
            ) : null}
            <View style={{ flex: 1 }}>
                {showRich ? (
                    <RichMarkdownEditorPanel
                        resetKey={resetKey}
                        editorRef={editorHandleRef}
                        value={props.value}
                        onChange={props.onChange}
                        onUnavailable={onUnavailable}
                        readOnly={props.readOnly}
                        // Inline toolbar lives in our header — suppress the
                        // panel's footer toolbar so the chrome doesn't double up.
                        hideFooterToolbar
                        onControllerChange={handleRichControllerChange}
                    />
                ) : (
                    <CodeEditor
                        ref={setEditorHandle}
                        resetKey={resetKey}
                        value={props.value}
                        language={language}
                        onChange={props.onChange}
                        readOnly={props.readOnly}
                        wrapLines={props.wrapLines ?? true}
                        showLineNumbers={false}
                    />
                )}
            </View>
        </View>
    );
}
