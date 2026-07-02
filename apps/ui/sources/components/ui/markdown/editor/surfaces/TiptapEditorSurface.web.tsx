import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';

import { TextInput } from '@/components/ui/text/Text';
import { useLocalSetting } from '@/sync/store/hooks';
import { resolveCodeEditorFontMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { getDefaultFont, getMonoFont } from '@/constants/Typography';

import type {
    LinkBubbleState,
    MarkdownEditorCommand,
    MarkdownEditorController,
    MarkdownEditorProps,
    MarkdownSelectionState,
    MenuTriggerKeyDownEvent,
    MenuTriggerState,
} from '../markdownEditorTypes';
import { resolveMarkdownEditorTheme } from '../markdownEditorTheme';
import { buildMarkdownProseCss } from '../markdownEditorProseStyle';
// Type-only import (erased at build time, so it never pulls the native WebView
// surface or `react-native-webview` into the web graph). Re-uses the single
// canonical merged ref type so web + native expose an identical ref.
import type { MarkdownEditorSurfaceRef } from './TiptapWebViewSurface.native';
import { createMarkdownEditorExtensions } from '../core/tiptap/createMarkdownEditorExtensions';
import { markdownToDoc } from '../core/tiptap/markdownSerialization';
import {
    readActiveLinkHref,
    readSelectionState,
    runMarkdownEditorCommand,
} from '../core/tiptap/markdownEditorCommands';

/**
 * Web editing surface for the unified `MarkdownEditor` (Lane W / W2).
 *
 * Mirrors `MonacoEditorSurface.web` exactly in shape: it mounts the editing
 * engine directly into the DOM (here a live `@tiptap/react` editor), keeps the
 * latest props in refs, debounces `onChange`, exposes a stable
 * `MarkdownEditorHandle` via `useImperativeHandle`, boots/remounts on `resetKey`,
 * and syncs external `value` changes without echoing them back as edits.
 *
 * The forwarded ref exposes BOTH the imperative handle
 * (`getValue`/`flushPendingChange`, for `useSessionFileEditorState`) AND the
 * platform-agnostic controller (`runCommand`/`subscribeSelection`, for the
 * toolbar) via {@link MarkdownEditorSurfaceRef}. The native surface (Lane N)
 * exposes the same combined ref, so the integration code is identical on both
 * platforms.
 *
 * R-A7: `onChange` is suppressed during the initial parse/seed (the editor is
 * seeded from `value` on creation) until the first real user transaction, so a
 * freshly opened document is never dirty-on-mount.
 *
 * NIT-3: serialization goes through `editor.getMarkdown()` (added by the
 * `@tiptap/markdown` extension), the SAME serialize path the native WebView
 * bundle entry and the eligibility round-trip use — so web/native are provably
 * identical and there is no second `MarkdownManager` instance on the web surface.
 *
 * R18: this file lives in the web graph and is the only surface allowed to import
 * `@tiptap/*`.
 */

const DEFAULT_CHANGE_DEBOUNCE_MS = 250;

export type { MarkdownEditorSurfaceRef } from './TiptapWebViewSurface.native';

export const TiptapEditorSurface = React.forwardRef<MarkdownEditorSurfaceRef, MarkdownEditorProps>(
    function TiptapEditorSurface(props, ref) {
        const { theme } = useUnistyles();
        const uiFontScale = useLocalSetting('uiFontScale');
        const fontMetrics = React.useMemo(
            () => resolveCodeEditorFontMetrics({ uiFontScale }),
            [uiFontScale],
        );

        const readOnly = props.readOnly ?? false;

        // Per-instance class applied to the `.ProseMirror` element so the injected
        // prose stylesheet (see effect below) is fully scoped and never leaks to
        // other editors/content.
        const proseClassRef = React.useRef<string>(`happier-md-prose-${Math.random().toString(36).slice(2)}`);
        const proseClass = proseClassRef.current;

        // --- Latest-prop refs (kept current via effects; read inside callbacks) ---
        const onChangeRef = React.useRef(props.onChange);
        const changeDebounceMsRef = React.useRef<number>(
            typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : DEFAULT_CHANGE_DEBOUNCE_MS,
        );
        const latestValueRef = React.useRef(props.value);
        // The markdown the editor was last seeded with (initial mount or external
        // sync). Used to suppress the initial-seed echo (R-A7).
        const seedRef = React.useRef(props.value);
        // While true, `onUpdate` is treated as a (programmatic) seed echo and does
        // not emit `onChange`. Lifted on the first divergent user transaction.
        const ignoreChangeRef = React.useRef(true);

        const pendingChangeRef = React.useRef<string | null>(null);
        const changeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const editorRef = React.useRef<Editor | null>(null);

        // Selection subscribers (the chrome subscribes via the controller).
        const selectionSubscribersRef = React.useRef(new Set<(state: MarkdownSelectionState) => void>());
        // Menu trigger subscribers (Lane F: slash menu).
        const menuTriggerSubscribersRef = React.useRef(new Set<(state: MenuTriggerState | null) => void>());
        const menuKeyDownSubscribersRef = React.useRef(new Set<(event: MenuTriggerKeyDownEvent) => boolean>());
        // Link bubble subscribers (Lane H: link bubble).
        const linkBubbleSubscribersRef = React.useRef(new Set<(state: LinkBubbleState | null) => void>());
        // Last-emitted link bubble state for dedup + replay to new subscribers.
        const lastLinkBubbleStateRef = React.useRef<LinkBubbleState | null>(null);

        React.useEffect(() => {
            onChangeRef.current = props.onChange;
        }, [props.onChange]);

        React.useEffect(() => {
            changeDebounceMsRef.current =
                typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : DEFAULT_CHANGE_DEBOUNCE_MS;
        }, [props.changeDebounceMs]);

        React.useEffect(() => {
            latestValueRef.current = props.value;
        }, [props.value]);

        const flushPendingChange = React.useCallback(() => {
            if (changeTimerRef.current != null) {
                clearTimeout(changeTimerRef.current);
                changeTimerRef.current = null;
            }
            if (pendingChangeRef.current == null) return;
            const next = pendingChangeRef.current;
            pendingChangeRef.current = null;
            onChangeRef.current(next);
        }, []);

        const scheduleChange = React.useCallback(
            (next: string) => {
                pendingChangeRef.current = next;
                const debounceMs = changeDebounceMsRef.current;
                if (debounceMs <= 0) {
                    flushPendingChange();
                    return;
                }
                if (changeTimerRef.current != null) {
                    clearTimeout(changeTimerRef.current);
                }
                changeTimerRef.current = setTimeout(() => {
                    flushPendingChange();
                }, debounceMs);
            },
            [flushPendingChange],
        );

        const notifySelection = React.useCallback((editor: Editor) => {
            const subscribers = selectionSubscribersRef.current;
            if (subscribers.size === 0) return;
            const state = readSelectionState(editor);
            for (const subscriber of subscribers) {
                subscriber(state);
            }
        }, []);

        // Lane H: compute + notify link bubble subscribers. Fires on selection
        // updates (same trigger as `notifySelection`) so the host can render the
        // bubble at the caret. Dedups identical states.
        const notifyLinkBubble = React.useCallback((editor: Editor) => {
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

            const prev = lastLinkBubbleStateRef.current;
            if (next === null && prev === null) return;
            if (
                next !== null
                && prev !== null
                && next.href === prev.href
                && next.caretRect.left === prev.caretRect.left
                && next.caretRect.top === prev.caretRect.top
                && next.caretRect.height === prev.caretRect.height
            ) {
                return;
            }
            lastLinkBubbleStateRef.current = next;
            for (const subscriber of linkBubbleSubscribersRef.current) {
                subscriber(next);
            }
        }, []);

        // Lane F: notify menu trigger subscribers when the extension fires.
        const notifyMenuTrigger = React.useCallback((state: MenuTriggerState | null) => {
            const subscribers = menuTriggerSubscribersRef.current;
            for (const subscriber of subscribers) {
                subscriber(state);
            }
        }, []);

        // Keep the notifyMenuTrigger ref current for the extension callback.
        const notifyMenuTriggerRef = React.useRef(notifyMenuTrigger);
        notifyMenuTriggerRef.current = notifyMenuTrigger;

        const notifyMenuKeyDown = React.useCallback((event: MenuTriggerKeyDownEvent): boolean => {
            let consumed = false;
            for (const subscriber of menuKeyDownSubscribersRef.current) {
                consumed = subscriber(event) || consumed;
            }
            return consumed;
        }, []);

        const notifyMenuKeyDownRef = React.useRef(notifyMenuKeyDown);
        notifyMenuKeyDownRef.current = notifyMenuKeyDown;

        const handleUpdate = React.useCallback(
            (editor: Editor) => {
                const next = editor.getMarkdown();
                if (ignoreChangeRef.current) {
                    // Still showing the seed; only a divergent transaction counts as
                    // a real user edit (R-A7).
                    if (next === seedRef.current) {
                        return;
                    }
                    ignoreChangeRef.current = false;
                }
                latestValueRef.current = next;
                scheduleChange(next);
            },
            [scheduleChange],
        );

        // Build the live editor. Seeded from `value`; the suffix in `resetKey` is
        // included in the dependency list so a reset rebuilds the editor with the
        // fresh seed (mirrors Monaco's resetKey-keyed boot). Event listeners are
        // attached via `editor.on(...)` in the effect below (not the option
        // callbacks) so they always read the latest refs without re-binding.
        const editor = useEditor(
            {
                extensions: createMarkdownEditorExtensions({
                    onMenuTriggerChange: (state) => notifyMenuTriggerRef.current(state),
                    onMenuTriggerKeyDown: (event) => notifyMenuKeyDownRef.current(event),
                }),
                content: markdownToDoc(props.value),
                editable: !readOnly,
                // Scope the prose stylesheet to THIS editor's contenteditable.
                editorProps: { attributes: { class: proseClass } },
            },
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [props.resetKey],
        );

        // Reset the seed/suppression state whenever the editor is (re)built for a
        // new reset key.
        React.useEffect(() => {
            seedRef.current = latestValueRef.current;
            ignoreChangeRef.current = true;
            pendingChangeRef.current = null;
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [props.resetKey]);

        // Stable platform-agnostic controller. The methods read the live editor
        // through `editorRef`, so the controller object identity never changes —
        // the chrome can keep a single subscription across editor rebuilds.
        const controllerRef = React.useRef<MarkdownEditorController | null>(null);
        if (controllerRef.current === null) {
            controllerRef.current = {
                runCommand: (command: MarkdownEditorCommand) => {
                    const live = editorRef.current;
                    if (!live) return;
                    runMarkdownEditorCommand(live, command, {
                        // Parity with native `Linking.openURL`: open the active link
                        // in a new tab. `noopener,noreferrer` prevents the opened page
                        // from accessing `window.opener` (tab-nabbing) or leaking the
                        // referrer (matches the command-registry default opener).
                        openLink: (href: string) => {
                            if (typeof window !== 'undefined' && typeof window.open === 'function') {
                                window.open(href, '_blank', 'noopener,noreferrer');
                            }
                        },
                    });
                },
                subscribeSelection: (callback: (state: MarkdownSelectionState) => void) => {
                    selectionSubscribersRef.current.add(callback);
                    // Push the current state immediately so the toolbar is correct
                    // on first paint.
                    const live = editorRef.current;
                    if (live) {
                        callback(readSelectionState(live));
                    }
                    return () => {
                        selectionSubscribersRef.current.delete(callback);
                    };
                },
                // Lane F: slash menu trigger subscription.
                subscribeMenuTrigger: (callback: (state: MenuTriggerState | null) => void) => {
                    menuTriggerSubscribersRef.current.add(callback);
                    return () => {
                        menuTriggerSubscribersRef.current.delete(callback);
                    };
                },
                subscribeMenuKeyDown: (callback: (event: MenuTriggerKeyDownEvent) => boolean) => {
                    menuKeyDownSubscribersRef.current.add(callback);
                    return () => {
                        menuKeyDownSubscribersRef.current.delete(callback);
                    };
                },
                // Lane F: run a slash menu command (optionally deleting the
                // trigger range first).
                runMenuCommand: (command: MarkdownEditorCommand, deleteRange?: { from: number; to: number }) => {
                    const live = editorRef.current;
                    if (!live) return;
                    if (deleteRange) {
                        try {
                            live.chain().focus().deleteRange(deleteRange).run();
                        } catch {
                            // Ignore invalid ranges; still attempt the command.
                        }
                    }
                    runMarkdownEditorCommand(live, command, {
                        openLink: (href: string) => {
                            if (typeof window !== 'undefined' && typeof window.open === 'function') {
                                window.open(href, '_blank', 'noopener,noreferrer');
                            }
                        },
                    });
                },
                // Lane H: link bubble subscription.
                subscribeLinkBubble: (callback: (state: LinkBubbleState | null) => void) => {
                    linkBubbleSubscribersRef.current.add(callback);
                    // Replay the latest known state immediately so a subscriber
                    // mounted after a link became active reflects it.
                    callback(lastLinkBubbleStateRef.current);
                    return () => {
                        linkBubbleSubscribersRef.current.delete(callback);
                    };
                },
            };
        }

        // Track the live editor instance and wire its events.
        React.useEffect(() => {
            editorRef.current = editor ?? null;
            if (!editor) return;

            const onUpdate = () => handleUpdate(editor);
            const onSelectionUpdate = () => {
                notifySelection(editor);
                // Lane H: piggyback on the same selection trigger so the link
                // bubble state stays in lockstep with selection state.
                notifyLinkBubble(editor);
            };
            editor.on('update', onUpdate);
            editor.on('selectionUpdate', onSelectionUpdate);
            editor.on('transaction', onSelectionUpdate);

            return () => {
                try {
                    editor.off('update', onUpdate);
                    editor.off('selectionUpdate', onSelectionUpdate);
                    editor.off('transaction', onSelectionUpdate);
                } catch {
                    // ignore
                }
            };
        }, [editor, handleUpdate, notifySelection, notifyLinkBubble]);

        // Keep editability in sync with the readOnly prop after mount.
        React.useEffect(() => {
            if (!editor) return;
            try {
                editor.setEditable(!readOnly);
            } catch {
                // ignore
            }
        }, [editor, readOnly]);

        // Sync external value changes into the editor without echoing them back as
        // user edits (mirrors Monaco's ignoreChangeRef guard).
        React.useEffect(() => {
            if (!editor) return;
            const current = editor.getMarkdown();
            if (current === props.value) return;
            seedRef.current = props.value;
            ignoreChangeRef.current = true;
            try {
                editor.commands.setContent(markdownToDoc(props.value));
            } catch {
                // ignore
            }
        }, [editor, props.value]);

        React.useImperativeHandle(
            ref,
            () => ({
                getValue: () => {
                    const live = editorRef.current;
                    if (!live) return latestValueRef.current;
                    try {
                        return live.getMarkdown();
                    } catch {
                        return latestValueRef.current;
                    }
                },
                flushPendingChange: async () => {
                    flushPendingChange();
                },
                runCommand: (command) => controllerRef.current?.runCommand(command),
                subscribeSelection: (callback) =>
                    controllerRef.current?.subscribeSelection(callback) ?? (() => {}),
                subscribeMenuTrigger: (callback) =>
                    controllerRef.current?.subscribeMenuTrigger?.(callback) ?? (() => {}),
                subscribeMenuKeyDown: (callback) =>
                    controllerRef.current?.subscribeMenuKeyDown?.(callback) ?? (() => {}),
                runMenuCommand: (command, deleteRange) =>
                    controllerRef.current?.runMenuCommand?.(command, deleteRange),
                subscribeLinkBubble: (callback) =>
                    controllerRef.current?.subscribeLinkBubble?.(callback) ?? (() => {}),
            }),
            [flushPendingChange],
        );

        // Flush any pending debounced change on unmount.
        React.useEffect(() => {
            return () => {
                try {
                    flushPendingChange();
                } catch {
                    // ignore
                }
                if (changeTimerRef.current != null) {
                    clearTimeout(changeTimerRef.current);
                    changeTimerRef.current = null;
                }
                selectionSubscribersRef.current.clear();
                menuTriggerSubscribersRef.current.clear();
                menuKeyDownSubscribersRef.current.clear();
                linkBubbleSubscribersRef.current.clear();
                lastLinkBubbleStateRef.current = null;
            };
        }, [flushPendingChange]);

        // Inject the scoped prose stylesheet into document.head. The editor renders
        // a real `.ProseMirror` contenteditable, so its typography + focus-outline
        // removal must be REAL CSS — RN-web inline styles on the EditorContent
        // wrapper don't reach the inner h1/p/code/etc. The CSS mirrors MarkdownView
        // (`buildEnrichedMarkdownStyle`) via the shared builder + the app fonts, so
        // the rich editor reads identically to the app's markdown rendering. Scoped
        // to `proseClass` so it never leaks; recomputed on theme/scale change.
        React.useEffect(() => {
            if (typeof document === 'undefined') return;
            const css = buildMarkdownProseCss(`.${proseClass}`, {
                fonts: {
                    body: getDefaultFont(),
                    heading: getDefaultFont('semiBold'),
                    mono: getMonoFont(),
                },
                colors: {
                    text: theme.colors.text.primary,
                    secondaryText: theme.colors.text.secondary,
                    link: theme.colors.text.link,
                    inlineCodeBackground: theme.colors.surface.selected,
                    codeBlockBackground: theme.colors.surface.elevated,
                    divider: theme.colors.border.default,
                },
                uiFontScale,
            });
            const styleEl = document.createElement('style');
            styleEl.setAttribute('data-happier-md-prose', proseClass);
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
            return () => {
                styleEl.remove();
            };
        }, [
            proseClass,
            uiFontScale,
            theme.colors.text.primary,
            theme.colors.text.secondary,
            theme.colors.text.link,
            theme.colors.surface.selected,
            theme.colors.surface.elevated,
            theme.colors.border.default,
        ]);

        // F10: resolve the prose tokens from the SAME shared resolver the native
        // surface uses, so web + native never drift apart.
        const editorTheme = resolveMarkdownEditorTheme(theme);
        const backgroundColor = editorTheme.backgroundColor;
        const dividerColor = editorTheme.dividerColor;
        const textColor = editorTheme.textColor;

        const borderStyle = {
            flex: 1,
            borderWidth: 1,
            borderColor: dividerColor,
            borderRadius: 10,
            overflow: 'hidden' as const,
            backgroundColor,
        };

        const ready = Boolean(editor);

        return (
            <View style={borderStyle}>
                <View
                    testID={props.testID}
                    style={{
                        flex: 1,
                        backgroundColor,
                        padding: 10,
                    }}
                >
                    {editor ? (
                        <EditorContent
                            editor={editor}
                            // This `style` lands on the EditorContent wrapper <div>
                            // (real DOM), which is the SCROLL CONTAINER: `flex:1` +
                            // `minHeight:0` let the flex child shrink below content and
                            // `overflowY:'auto'` (valid DOM CSS, unlike RN's overflow)
                            // provides the scrollbar — without it the ancestor
                            // `overflow:'hidden'` clips long docs with no way to scroll.
                            // Typography/color/focus-outline live in the injected prose
                            // stylesheet scoped to `.${proseClass}` on the inner
                            // `.ProseMirror`, NOT here (inline styles don't reach the
                            // inner h1/p/code; and React treats `lineHeight` as unitless).
                            style={{
                                flex: 1,
                                minHeight: 0,
                                overflowY: 'auto',
                            }}
                        />
                    ) : null}
                </View>
                {ready ? null : (
                    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}>
                        <TextInput
                            value={props.value}
                            onChangeText={props.onChange}
                            editable={!readOnly}
                            multiline
                            disableUiFontScaling
                            style={{
                                flex: 1,
                                padding: 10,
                                color: textColor,
                                backgroundColor,
                                fontSize: fontMetrics.fontSize,
                                lineHeight: fontMetrics.lineHeight,
                            }}
                        />
                    </View>
                )}
            </View>
        );
    },
);
