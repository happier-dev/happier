import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import type { CodeEditorDocumentChange, EditorDocumentHistory, TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { usePublishCodeEditorHandle } from '@/components/ui/code/editor/usePublishCodeEditorHandle';
import { CommandMenu } from '@/components/ui/commandMenu';
import { LinkBubble } from '@/components/ui/linkBubble';
import { MarkdownEditor, type MarkdownEditorSurfaceRef } from '@/components/ui/markdown/editor/MarkdownEditor';
import {
    extractFrontMatter,
    reattachFrontMatter,
} from '@/components/ui/markdown/editor/core/eligibility/markdownFrontmatter';
import { useMarkdownLinkBubble } from '@/components/ui/markdown/editor/linkBubble/useMarkdownLinkBubble';
import type {
    MarkdownEditorCommand,
    MarkdownEditorController,
    MarkdownSelectionState,
} from '@/components/ui/markdown/editor/markdownEditorTypes';
import { isMutatingMarkdownEditorCommand } from '@/components/ui/markdown/editor/markdownEditorTypes';
import { useMarkdownSlashMenu } from '@/components/ui/markdown/editor/slash/useMarkdownSlashMenu';
import { MarkdownEditorToolbar } from '@/components/ui/markdown/editorChrome/MarkdownEditorToolbar';
import { Text } from '@/components/ui/text/Text';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Generic rich (WYSIWYG) markdown editing surface (Lane I / I1, generalized in
 * Lane A). Originally the rich sibling of the file-pane's `FileEditorPanel`, it
 * carries NO file-pane coupling, so it is reused for the prompt/skill editor
 * screens too (via `MarkdownCodeEditorField`) alongside `WorkspaceFileDetailsView`.
 *
 * Holds a single `MarkdownEditorSurfaceRef` — the combined ref both platform
 * surfaces expose (`getValue`/`flushPendingChange` + `runCommand`/
 * `subscribeSelection`). A WRAPPED handle is published on the parent's
 * `editorRef` (typed `CodeEditorHandle`) so `useWorkspaceFileEditorState` can
 * drive save/flush unchanged (D5). The controller half drives the
 * `MarkdownEditorToolbar`, which stays platform-agnostic.
 *
 * ## Frontmatter strip / reattach (S1 / §5.3 idempotency #1 risk)
 * A leading YAML frontmatter block must NEVER reach the TipTap content (TipTap's
 * markdown round-trip can silently rewrite it → false-dirty / data loss on save).
 * So we:
 *  - split `{ frontmatter, body }` from `props.value` and seed the editor with the
 *    `body` only;
 *  - show the frontmatter as a read-only, monospace, themed banner above the editor;
 *  - reattach the (verbatim) frontmatter on EVERY path that hands markdown back to
 *    the host — the published `getValue()`, `onChange`, and the native
 *    `onUnavailable` fallback — so the full document is always preserved
 *    byte-for-byte.
 *
 * The current frontmatter is projected from the seed and shared-history edits,
 * so an unrelated render cannot replace live bytes with an older seed.
 *
 * Props mirror `FileEditorPanel` (resetKey/editorRef/value/onChange) plus
 * `onUnavailable`, which the native surface uses to hand the freshest markdown
 * up on a bundle/`error` fallback so the host can seed raw synchronously
 * (R-A15/R-A17). The shared `useMarkdownEditMode` owns the raw<->rich
 * crossfade and remount, so this panel renders only the editing surface.
 *
 * The frontmatter banner reads the active theme directly via `useUnistyles()`
 * (the app's standard theme hook) rather than taking a `theme` prop — keeping
 * the public surface free of an untyped `theme: any` escape hatch.
 */
const FRAMED_PANEL_STYLE = { flex: 1, paddingHorizontal: 16, paddingVertical: 12 } as const;
const CANVAS_PANEL_STYLE = { flex: 1 } as const;

function RichMarkdownEditorPanelImpl(props: Readonly<{
    resetKey: string;
    editorRef: Readonly<React.MutableRefObject<TextEditorHandle | null>>;
    onEditorHandleChange?: (handle: TextEditorHandle | null) => void;
    value: string;
    onChange: (next: string, change?: CodeEditorDocumentChange) => void;
    history?: EditorDocumentHistory;
    onUnavailable?: (latestMarkdown: string) => void;
    onReady?: () => void;
    readOnly?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
    /**
     * Suppress the internal footer toolbar. Used when an ancestor (e.g.
     * `MarkdownCodeEditorField`) renders an inline header toolbar so the chrome
     * doesn't appear twice. Default `false` preserves the file-pane's
     * keyboard-sticky footer.
     */
    hideFooterToolbar?: boolean;
    /**
     * Publishes the live `MarkdownEditorController` to the parent on mount and
     * `null` on unmount. Stable identity across resetKey changes (the controller
     * reads through a live surface ref internally), so an ancestor can wire its
     * own toolbar above the editor and stop hosting one inside the panel.
     */
    onControllerChange?: (controller: MarkdownEditorController | null) => void;
    /** `canvas`: the document is the page — no frame and no inset of its own. Default framed. */
    presentation?: 'framed' | 'canvas';
}>) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const surfaceRef = React.useRef<MarkdownEditorSurfaceRef | null>(null);
    const publishEditorHandle = usePublishCodeEditorHandle(props.editorRef, props.onEditorHandleChange);

    // Split the leading YAML frontmatter off the document. The editor only ever
    // sees `body`; `frontmatter` is shown read-only and re-prepended on every
    // markdown hand-off (S1 / §5.3). Memoized on `props.value` so a stable seed
    // is fed to the surface across unrelated re-renders.
    const { frontmatter: seedFrontmatter, body } = React.useMemo(() => extractFrontMatter(props.value), [props.value]);
    const [frontmatter, setFrontmatter] = React.useState(seedFrontmatter);

    // Hosts may keep a stable seed while live text belongs to an external store.
    // Adopt a new seed only when it changes; Undo can update frontmatter in between.
    const frontmatterRef = React.useRef<string | null>(frontmatter);
    const frontmatterSeedRef = React.useRef({ value: props.value, resetKey: props.resetKey });
    if (frontmatterSeedRef.current.value !== props.value || frontmatterSeedRef.current.resetKey !== props.resetKey) {
        frontmatterSeedRef.current = { value: props.value, resetKey: props.resetKey };
        frontmatterRef.current = seedFrontmatter;
        setFrontmatter(seedFrontmatter);
    }
    const updateFrontmatter = React.useCallback((next: string | null) => {
        frontmatterRef.current = next;
        setFrontmatter(next);
    }, []);
    const bodyHistory = React.useMemo<EditorDocumentHistory | undefined>(() => props.history ? {
        getSnapshot: () => props.history!.getSnapshot(),
        subscribe: listener => props.history!.subscribe(listener),
        undo: value => {
            const result = props.history!.undo(reattachFrontMatter(frontmatterRef.current, value));
            if (result === null) return null;
            const next = extractFrontMatter(result);
            updateFrontmatter(next.frontmatter);
            return next.body;
        },
        redo: value => {
            const result = props.history!.redo(reattachFrontMatter(frontmatterRef.current, value));
            if (result === null) return null;
            const next = extractFrontMatter(result);
            updateFrontmatter(next.frontmatter);
            return next.body;
        },
    } : undefined, [props.history, updateFrontmatter]);

    // Publish a WRAPPED handle onto the parent's CodeEditorHandle ref. The surface
    // returns body-only markdown, so the wrapper reattaches frontmatter before the
    // file-edit machine reads it for save (else save would DROP the frontmatter).
    const setSurfaceRef = React.useCallback((instance: MarkdownEditorSurfaceRef | null) => {
        surfaceRef.current = instance;
        if (!instance) {
            publishEditorHandle(null);
            return;
        }
        publishEditorHandle({
            getValue: () => reattachFrontMatter(frontmatterRef.current, instance.getValue()),
            flushPendingChange: () => instance.flushPendingChange(),
            focus: () => instance.focus?.(),
            find: instance.find,
            runCommand: command => {
                if (typeof command === 'object' && 'replaceDocument' in command) {
                    const next = extractFrontMatter(command.replaceDocument);
                    instance.runTextCommand?.({ ...command, replaceDocument: next.body }, () => updateFrontmatter(next.frontmatter));
                } else instance.runTextCommand?.(command);
            },
            subscribeHistory: instance.subscribeHistory,
        });
    }, [publishEditorHandle, updateFrontmatter]);

    // Reattach frontmatter to the body-only markdown the surface emits before it
    // flows up to the host (keeps the host's tracked text + dirty state correct).
    const handleSurfaceChange = React.useCallback((next: string, change?: CodeEditorDocumentChange) => {
        if (change) props.onChange(reattachFrontMatter(frontmatterRef.current, next), change);
        else props.onChange(reattachFrontMatter(frontmatterRef.current, next));
    }, [props.onChange]);

    // Native fallback: the surface hands its freshest body-only markdown; reattach
    // so the raw editor is seeded with the FULL doc, not body-only (S1 / R-A17).
    const handleSurfaceUnavailable = React.useCallback((latest: string) => {
        props.onUnavailable?.(reattachFrontMatter(frontmatterRef.current, latest));
    }, [props.onUnavailable]);

    // Stable controller for the toolbar that always reads through the live ref,
    // so it keeps working across surface remounts (resetKey changes). We hold the
    // `readOnly` prop in a ref so the controller object identity stays stable
    // across renders (an ancestor that subscribes via `onControllerChange` would
    // otherwise see a fresh controller every time `readOnly` flips).
    const readOnlyRef = React.useRef(props.readOnly);
    readOnlyRef.current = props.readOnly;
    const controller = React.useMemo<MarkdownEditorController>(() => ({
        runCommand: (command: MarkdownEditorCommand) => {
            if (readOnlyRef.current && isMutatingMarkdownEditorCommand(command)) {
                return;
            }
            surfaceRef.current?.runCommand(command);
        },
        subscribeSelection: (callback: (state: MarkdownSelectionState) => void) => {
            const surface = surfaceRef.current;
            if (!surface) {
                return () => {};
            }
            return surface.subscribeSelection(callback);
        },
        subscribeMenuTrigger: (callback) => {
            return surfaceRef.current?.subscribeMenuTrigger?.(callback) ?? (() => {});
        },
        subscribeMenuKeyDown: (callback) => {
            return surfaceRef.current?.subscribeMenuKeyDown?.(callback) ?? (() => {});
        },
        runMenuCommand: (command, deleteRange) => {
            if (readOnlyRef.current && isMutatingMarkdownEditorCommand(command)) {
                return;
            }
            surfaceRef.current?.runMenuCommand?.(command, deleteRange);
        },
        subscribeEditorViewportLayout: (callback) => {
            return surfaceRef.current?.subscribeEditorViewportLayout?.(callback) ?? (() => {});
        },
        measureEditorViewportInWindow: () => {
            return surfaceRef.current?.measureEditorViewportInWindow?.() ?? Promise.resolve(null);
        },
        subscribeLinkBubble: (callback) => {
            return surfaceRef.current?.subscribeLinkBubble?.(callback) ?? (() => {});
        },
    }), []);

    // Publish the controller to an interested ancestor on mount; clear on unmount
    // so a stale identity can't outlive the panel.
    const onControllerChange = props.onControllerChange;
    React.useEffect(() => {
        if (!onControllerChange) return;
        onControllerChange(controller);
        return () => {
            onControllerChange(null);
        };
    }, [controller, onControllerChange]);

    const slashMenu = useMarkdownSlashMenu(props.readOnly ? null : controller);
    const linkBubble = useMarkdownLinkBubble(controller);

    return (
        <View style={props.presentation === 'canvas' ? CANVAS_PANEL_STYLE : FRAMED_PANEL_STYLE}>
            {frontmatter !== null ? (
                <View
                    testID="file-details-rich-editor-frontmatter"
                    pointerEvents="none"
                    style={{
                        marginBottom: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: paintColor(theme.colors.surface.inset),
                    }}
                >
                    <Text
                        style={{
                            fontSize: 11,
                            marginBottom: 6,
                            color: theme.colors.text.secondary,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        {t('files.fileEditor.frontmatterReadOnly')}
                    </Text>
                    <Text
                        style={{
                            fontSize: 12,
                            color: theme.colors.text.secondary,
                            ...Typography.mono(),
                        }}
                    >
                        {frontmatter.trimEnd()}
                    </Text>
                </View>
            ) : null}
            <View style={{ flex: 1 }}>
                <MarkdownEditor
                    ref={setSurfaceRef}
                    resetKey={props.resetKey}
                    value={body}
                    onChange={handleSurfaceChange}
                    history={bodyHistory}
                    onUnavailable={handleSurfaceUnavailable}
                    onReady={props.onReady}
                    readOnly={props.readOnly}
                    changeDebounceMs={props.changeDebounceMs}
                    bridgeMaxChunkBytes={props.bridgeMaxChunkBytes}
                    presentation={props.presentation}
                    testID="file-details-rich-editor"
                />
            </View>
            {props.readOnly || props.hideFooterToolbar ? null : (
                <MarkdownEditorToolbar controller={controller} testID="file-details-rich-editor-toolbar" />
            )}
            <CommandMenu
                open={slashMenu.open}
                anchor={slashMenu.anchor}
                query={slashMenu.query}
                items={slashMenu.items}
                selectedIndex={slashMenu.selectedIndex}
                onMoveUp={slashMenu.onMoveUp}
                onMoveDown={slashMenu.onMoveDown}
                onSelect={slashMenu.onSelect}
                onRequestClose={slashMenu.onRequestClose}
                placement="bottom"
                testID="markdown-slash-menu"
            />
            <LinkBubble
                open={linkBubble.open}
                anchor={linkBubble.anchor}
                href={linkBubble.href}
                onOpenLink={linkBubble.onOpenLink}
                onUnlink={linkBubble.onUnlink}
                onSetLink={linkBubble.onSetLink}
                onRequestClose={linkBubble.onRequestClose}
                testID="markdown-link-bubble"
            />
        </View>
    );
}

export const RichMarkdownEditorPanel = React.memo((props: React.ComponentProps<typeof RichMarkdownEditorPanelImpl>) => (
    // Keep the controller and its selection/menu subscribers in the same ready
    // commit as the surface; a boundary inside MarkdownEditor would commit them
    // once against a null ref and leave them disconnected after lazy admission.
    <React.Suspense fallback={<PaneLoadingFallback testID="rich-markdown-editor-loading" />}>
        <RichMarkdownEditorPanelImpl {...props} />
    </React.Suspense>
));
