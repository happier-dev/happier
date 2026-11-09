/**
 * esbuild entry for the native TipTap WebView bundle.
 *
 * This module is bundled (iife, browser, es2020, minified) by
 * `apps/ui/tools/tiptap/buildTiptapWebViewBundle.mjs` into
 * `bridge/tiptapWebViewBundle.generated.ts` as `TIPTAP_WEBVIEW_BUNDLE_JS`. It runs
 * INSIDE the WebView and assigns `globalThis.HAPPIER_TIPTAP_WEBVIEW`, the boot
 * API the inline HTML script (`tiptapWebViewHtml.ts`) calls after the bundle is
 * inlined.
 *
 * D4: uses headless `@tiptap/core` `Editor` — NO React.
 * R18: imports `@tiptap/*`; only ever bundled into the WEB bundle (never the RN
 * JS graph).
 *
 * The chunked postMessage transport lives in the HTML (mirrors CodeMirror): the
 * HTML decodes incoming envelopes + encodes outgoing ones and hands this runtime
 * a `postEnvelope` callback + a `root` element. This runtime owns the editor +
 * command/selection logic.
 */

import { Editor } from '@tiptap/core';

import { createMarkdownEditorExtensions } from '../core/tiptap/createMarkdownEditorExtensions';
import {
    readSelectionState,
    runMarkdownEditorCommand,
} from '../core/tiptap/markdownEditorCommands';
import { seedMarkdown } from '../core/tiptap/seedMarkdown';
import { createTiptapFind } from '../core/tiptap/tiptapFind';
import type { MenuTriggerKeyDownEvent, MenuTriggerState } from '../core/tiptap/menuTriggerExtensionTypes';
import type {
    LinkBubbleState,
    MarkdownEditorCommand,
    MarkdownSelectionState,
} from '../markdownEditorTypes';
import { readActiveLinkHref } from '../core/tiptap/markdownEditorCommands';

type Envelope = Readonly<{ v: 1; type: string; payload?: unknown }>;

type PostEnvelope = (envelope: Envelope) => void;

export type TiptapWebViewRuntimeConfig = Readonly<{
    /** Debounce window (ms) for `docChanged` + `selectionState` emission. */
    changeDebounceMs: number;
    /** Whether the editor starts read-only. */
    readOnly: boolean;
    sharedHistory?: boolean;
}>;

export type TiptapWebViewRuntime = Readonly<{
    /** Handle a decoded envelope from the host. */
    onEnvelope: (envelope: Envelope) => void;
    /** Tear down the editor (e.g. on reload). */
    destroy: () => void;
}>;

export type TiptapWebViewApi = Readonly<{
    /**
     * Builds the in-WebView editor runtime. The HTML calls this once after the
     * bundle is inlined, supplying the mount element + the chunked transport.
     */
    createRuntime: (params: Readonly<{
        root: HTMLElement;
        postEnvelope: PostEnvelope;
        config: TiptapWebViewRuntimeConfig;
    }>) => TiptapWebViewRuntime;
}>;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseMarkdownEditorCommandEnvelopePayload(
    payload: Record<string, unknown>,
): MarkdownEditorCommand | null {
    const name = payload.name;
    const args = asRecord(payload.args);
    if (typeof name !== 'string') {
        return null;
    }

    switch (name) {
        case 'toggleBold':
        case 'toggleItalic':
        case 'toggleStrike':
        case 'toggleCode':
        case 'toggleBulletList':
        case 'toggleOrderedList':
        case 'toggleTaskList':
        case 'toggleBlockquote':
        case 'toggleCodeBlock':
        case 'setHorizontalRule':
        case 'unlink':
        case 'openLink':
            return { kind: name };
        case 'setHeading': {
            const level = args.level;
            return level === 1 || level === 2 || level === 3
                ? { kind: 'setHeading', level }
                : null;
        }
        case 'setLink': {
            const href = args.href;
            return typeof href === 'string'
                ? { kind: 'setLink', href }
                : null;
        }
        default:
            return null;
    }
}

function selectionStatesEqual(a: MarkdownSelectionState, b: MarkdownSelectionState): boolean {
    return (
        a.marks.bold === b.marks.bold
        && a.marks.italic === b.marks.italic
        && a.marks.strike === b.marks.strike
        && a.marks.code === b.marks.code
        && a.blockType === b.blockType
        && a.isLinkActive === b.isLinkActive
        && a.linkHref === b.linkHref
        && a.canUndo === b.canUndo
        && a.canRedo === b.canRedo
    );
}

function createRuntime(params: Readonly<{
    root: HTMLElement;
    postEnvelope: PostEnvelope;
    config: TiptapWebViewRuntimeConfig;
}>): TiptapWebViewRuntime {
    const { root, postEnvelope, config } = params;

    let applyingRemote = false;
    let seeded = false;
    let source = '';
    let edited = false;
    const sharedHistory = config.sharedHistory === true;
    let docChangeTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSelectionState: MarkdownSelectionState | null = null;
    let lastMenuTriggerState: MenuTriggerState | null = null;
    let lastLinkBubbleState: LinkBubbleState | null = null;

    const emitDocChanged = (editor: Editor) => {
        try {
            postEnvelope({ v: 1, type: 'docChanged', payload: { doc: editor.getMarkdown() } });
        } catch {
            // Ignore serialization errors; the host keeps the last good mirror.
        }
    };

    const cancelPendingDocChange = () => {
        if (docChangeTimer) {
            clearTimeout(docChangeTimer);
            docChangeTimer = null;
        }
    };

    const emitSelectionState = (editor: Editor) => {
        const next = readSelectionState(editor, sharedHistory ? { canUndo: false, canRedo: false } : undefined);
        if (lastSelectionState && selectionStatesEqual(lastSelectionState, next)) {
            return;
        }
        lastSelectionState = next;
        postEnvelope({ v: 1, type: 'selectionState', payload: next });
    };

    /**
     * Emit link bubble state change to the host (Lane H).
     *
     * Fires when the caret enters/leaves a link mark, or when the href under
     * the caret changes. Reuses the SAME debounce timer as `selectionState`
     * (D8) — both are driven from `onSelectionUpdate` so their time-of-arrival
     * stays consistent.
     */
    const emitLinkBubbleChanged = (editor: Editor) => {
        const isActive = editor.isActive('link');
        let next: LinkBubbleState | null = null;
        if (isActive) {
            const href = readActiveLinkHref(editor);
            if (typeof href === 'string' && href.length > 0) {
                try {
                    const coords = editor.view.coordsAtPos(editor.state.selection.from);
                    next = {
                        href,
                        caretRect: {
                            left: coords.left,
                            top: coords.top,
                            height: coords.bottom - coords.top,
                        },
                    };
                } catch {
                    next = null;
                }
            }
        }

        // Dedup: null→null and identical-shape transitions are suppressed so the
        // host doesn't get re-renders for cursor moves within the same link
        // position. (Same dedup shape as `menuTriggerChanged`.)
        if (next === null && lastLinkBubbleState === null) return;
        if (
            next !== null
            && lastLinkBubbleState !== null
            && next.href === lastLinkBubbleState.href
            && next.caretRect.left === lastLinkBubbleState.caretRect.left
            && next.caretRect.top === lastLinkBubbleState.caretRect.top
            && next.caretRect.height === lastLinkBubbleState.caretRect.height
        ) {
            return;
        }
        lastLinkBubbleState = next;
        postEnvelope({ v: 1, type: 'linkBubbleChanged', payload: next });
    };

    /** Emit menu trigger state change to the host (Lane F). */
    const emitMenuTriggerChanged = (state: MenuTriggerState | null) => {
        // Avoid sending duplicate null→null or identical trigger states.
        if (state === null && lastMenuTriggerState === null) return;
        if (
            state !== null
            && lastMenuTriggerState !== null
            && state.kind === lastMenuTriggerState.kind
            && state.query === lastMenuTriggerState.query
            && state.from === lastMenuTriggerState.from
            && state.to === lastMenuTriggerState.to
            && state.caretRect.left === lastMenuTriggerState.caretRect.left
            && state.caretRect.top === lastMenuTriggerState.caretRect.top
            && state.caretRect.height === lastMenuTriggerState.caretRect.height
        ) {
            return;
        }
        lastMenuTriggerState = state;
        postEnvelope({ v: 1, type: 'menuTriggerChanged', payload: state });
    };

    const editor = new Editor({
        element: root,
        editorProps: {
            handleDOMEvents: {
                beforeinput: (view, event) => {
                    if (!sharedHistory || !view.editable || view.composing || event.isComposing
                        || (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo')) return false;
                    event.preventDefault();
                    postEnvelope({ v: 1, type: 'history.command', payload: { command: event.inputType === 'historyUndo' ? 'undo' : 'redo' } });
                    return true;
                },
            },
            handleKeyDown: (view, event) => {
                if (!sharedHistory || !view.editable || view.composing || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return false;
                const key = event.key.toLowerCase();
                if (key !== 'z' && key !== 'y') return false;
                event.preventDefault();
                postEnvelope({ v: 1, type: 'history.command', payload: { command: key === 'y' || event.shiftKey ? 'redo' : 'undo' } });
                return true;
            },
        },
        extensions: createMarkdownEditorExtensions({
            sharedHistory,
            onMenuTriggerChange: emitMenuTriggerChanged,
            onMenuTriggerKeyDown: (event: MenuTriggerKeyDownEvent) => {
                postEnvelope({ v: 1, type: 'menuTriggerKeyDown', payload: event });
                return true;
            },
        }),
        content: '',
        contentType: 'markdown',
        editable: !config.readOnly,
        autofocus: false,
        // Open links via a host bridge message rather than navigating the WebView.
        onUpdate: () => {
            if (applyingRemote) {
                return;
            }
            // Suppress the initial seed echo (R-A7): the first programmatic seed
            // must not look like a user edit.
            if (!seeded) {
                return;
            }
            edited = true;
            if (docChangeTimer) {
                clearTimeout(docChangeTimer);
            }
            docChangeTimer = setTimeout(() => {
                docChangeTimer = null;
                emitDocChanged(editor);
            }, config.changeDebounceMs);
        },
        onSelectionUpdate: () => {
            if (selectionTimer) {
                clearTimeout(selectionTimer);
            }
            // D8: `linkBubbleChanged` reuses the SAME debounce constant/timer
            // as `selectionState` so the host receives both envelopes in a
            // consistent order. Two debouncers would drift.
            selectionTimer = setTimeout(() => {
                emitSelectionState(editor);
                emitLinkBubbleChanged(editor);
            }, config.changeDebounceMs);
        },
    });

    const richFind = createTiptapFind(editor);
    richFind.find.subscribe(() => postEnvelope({ v: 1, type: 'find.status', payload: richFind.find.getSnapshot() }));

    const setDoc = (nextDoc: string) => {
        const current = editor.getMarkdown();
        if (current === nextDoc) {
            source = nextDoc;
            edited = false;
            // Editor and host agree; any still-pending change is a settled echo.
            cancelPendingDocChange();
            return;
        }
        if (docChangeTimer) {
            // Unflushed local edits: the incoming doc is stale relative to the editor.
            // Replacing the document would reset the cursor and drop in-flight keystrokes.
            // Local text wins; flush it upward so the host state converges instead.
            cancelPendingDocChange();
            emitDocChanged(editor);
            return;
        }
        applyingRemote = true;
        try {
            // Encode-on-input via the shared seed helper so the risky-markdown
            // pre-pass runs on this seed boundary too (raw HTML / comments →
            // byte-verbatim atoms).
            seedMarkdown(editor, nextDoc, { preserveViewState: true });
            source = nextDoc;
            edited = false;
        } finally {
            applyingRemote = false;
        }
    };

    const openLinkViaHost = (href: string) => {
        postEnvelope({ v: 1, type: 'openLink', payload: { href } });
    };

    const onEnvelope = (envelope: Envelope) => {
        if (!envelope || envelope.v !== 1 || typeof envelope.type !== 'string') {
            return;
        }
        const payload = (envelope.payload ?? {}) as Record<string, unknown>;

        if (envelope.type === 'init') {
            const doc = typeof payload.doc === 'string' ? payload.doc : '';
            const readOnly = payload.readOnly === true;
            cancelPendingDocChange();
            editor.setEditable(!readOnly);
            applyingRemote = true;
            try {
                // Encode-on-input via the shared seed helper (see `setDoc`).
                seedMarkdown(editor, doc);
                source = doc;
                edited = false;
            } finally {
                applyingRemote = false;
            }
            seeded = true;
            return;
        }

        if (envelope.type === 'setDoc') {
            setDoc(typeof payload.doc === 'string' ? payload.doc : '');
            return;
        }

        if (envelope.type === 'text.command') {
            if (!editor.isEditable) return;
            const command = payload.command;
            if (command === 'undo' || command === 'redo') {
                if (sharedHistory) postEnvelope({ v: 1, type: 'history.command', payload: { command } });
                else editor.commands[command]();
            } else if (command && typeof command === 'object' && 'replaceDocument' in command && typeof command.replaceDocument === 'string') {
                cancelPendingDocChange();
                applyingRemote = true;
                try {
                    seedMarkdown(editor, command.replaceDocument, { preserveViewState: true });
                    source = command.replaceDocument;
                    edited = false;
                } finally { applyingRemote = false; }
            }
            emitSelectionState(editor);
            return;
        }

        if (envelope.type === 'requestDoc') {
            const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
            let doc = '';
            try {
                doc = edited ? editor.getMarkdown() : source;
            } catch {
                doc = '';
            }
            postEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc } });
            return;
        }

        if (envelope.type === 'command') {
            const command = parseMarkdownEditorCommandEnvelopePayload(payload);
            if (!command) {
                return;
            }

            // Lane F: when `deleteRange` is present (slash menu commit), delete
            // the trigger range (`/query`) BEFORE running the command so the
            // entire operation is a single undo step.
            const rawDeleteRange = payload.deleteRange;
            if (
                rawDeleteRange
                && typeof rawDeleteRange === 'object'
                && rawDeleteRange !== null
                && typeof (rawDeleteRange as Record<string, unknown>).from === 'number'
                && typeof (rawDeleteRange as Record<string, unknown>).to === 'number'
            ) {
                const from = (rawDeleteRange as Record<string, unknown>).from as number;
                const to = (rawDeleteRange as Record<string, unknown>).to as number;
                try {
                    editor.chain().focus().deleteRange({ from, to }).run();
                } catch {
                    // Ignore invalid ranges; still attempt the command below.
                }
            }

            try {
                runMarkdownEditorCommand(editor, command, { openLink: openLinkViaHost });
            } catch {
                // Ignore invalid commands; never crash the WebView.
            }
            // A command may change marks/doc; emit fresh state promptly.
            emitSelectionState(editor);
            emitLinkBubbleChanged(editor);
        }
        if (envelope.type === 'find.set' && typeof payload.query === 'string') {
            const options = asRecord(payload.options);
            if (typeof options.matchCase === 'boolean' && typeof options.regex === 'boolean') {
                richFind.find.set(payload.query, { matchCase: options.matchCase, regex: options.regex });
            }
        } else if (envelope.type === 'find.step' && (payload.direction === 1 || payload.direction === -1)) {
            richFind.find.step(payload.direction);
        } else if (envelope.type === 'find.close') {
            richFind.find.close();
        }
    };

    const destroy = () => {
        richFind.destroy();
        cancelPendingDocChange();
        if (selectionTimer) {
            clearTimeout(selectionTimer);
        }
        try {
            editor.destroy();
        } catch {
            // Best-effort teardown.
        }
    };

    return { onEnvelope, destroy };
}

const api: TiptapWebViewApi = { createRuntime };

declare global {
    // eslint-disable-next-line no-var
    var HAPPIER_TIPTAP_WEBVIEW: TiptapWebViewApi | undefined;
}

globalThis.HAPPIER_TIPTAP_WEBVIEW = api;

export { api as tiptapWebViewApi };
