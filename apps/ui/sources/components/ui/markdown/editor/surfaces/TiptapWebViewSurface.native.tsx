import React from 'react';
import { Linking, PixelRatio, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/store/hooks';
import { useWebViewBridgeMessenger } from '@/components/ui/webview/bridge/useWebViewBridgeMessenger';
import type { WebViewBridgeEnvelopeV1 } from '@/components/ui/webview/bridge/chunkedBridge';

import type {
    EditorViewportWindowRect,
    LinkBubbleState,
    MarkdownBlockType,
    MarkdownEditorCommand,
    MarkdownEditorController,
    MarkdownEditorHandle,
    MarkdownEditorProps,
    MarkdownSelectionState,
    MenuTriggerKeyDownEvent,
    MenuTriggerState,
} from '../markdownEditorTypes';
import { resolveMarkdownEditorTheme } from '../markdownEditorTheme';
import { buildTiptapWebViewHtml } from '../bridge/tiptapWebViewHtml';
import { resolveNativeOpenableMarkdownHref } from '../core/tiptap/markdownLinkOpening';

/**
 * Native TipTap editor surface (Lane N / N2).
 *
 * Mirrors `code/editor/surfaces/CodeMirrorWebViewSurface.native.tsx`: TipTap runs
 * inside a `react-native-webview`, the host talks to it over the chunked
 * postMessage bridge (R4), and `lastDocRef` mirrors the document so `getValue()`
 * stays synchronous (R5). The only place TipTap reaches native is the prebuilt
 * bundle string baked into `buildTiptapWebViewHtml` — this file (and everything
 * it imports) MUST NOT import any `@tiptap/*` (R18).
 *
 * D8/R-A5/N2: the already-identical transport plumbing (chunked encode/post,
 * chunked decode/dispatch, the one-shot `ready` handshake) is owned by the shared
 * {@link useWebViewBridgeMessenger} hook — this surface does NOT hand-roll it. The
 * surface still owns everything surface-specific (the `<WebView>` element,
 * `resetKey` remount, `lastDocRef`/`getValue`, the pending-doc flush map, and the
 * TipTap-specific `init/setDoc/command/selectionState/openLink` envelope
 * handling). The wire format is therefore byte-identical to before — the hook
 * encodes via the same `chunkedBridge` with the same defaults.
 *
 * Two TipTap-specific differences vs CodeMirror:
 *  - It also bridges `command` (down) + `selectionState` (up) so the RN chrome
 *    can drive formatting via a {@link MarkdownEditorController} (the chrome stays
 *    platform-agnostic).
 *  - D9/R-A17: on a boot/bundle `error` (no CDN fallback) it calls
 *    `onUnavailable(lastDocRef.current)` synchronously — handing the freshest
 *    markdown directly to the parent so it can seed raw mode without losing the
 *    edit (a separate batched `onChange` would be unreliable).
 *
 * The ref exposes BOTH the imperative handle (`getValue`/`flushPendingChange`,
 * for `useSessionFileEditorState`) AND the controller (`runCommand`/
 * `subscribeSelection`, for the toolbar) via {@link MarkdownEditorSurfaceRef}.
 * The web surface (Lane W) exposes the same combined ref so the integration code
 * is identical on both platforms.
 */
export type MarkdownEditorSurfaceRef = MarkdownEditorHandle & MarkdownEditorController;

/**
 * Typed wire format for the inbound envelopes the TipTap WebView bundle emits
 * (mirrors what `buildTiptapWebViewHtml` posts back over the chunked bridge).
 * The transport delivers each envelope as a `WebViewBridgeEnvelopeV1` whose
 * `payload` is `unknown`, so every inbound payload crosses a trust boundary and
 * MUST be validated before its fields reach subscribers — a malformed/partial
 * payload from the bundle must be ignored, never silently forwarded.
 */
type DocChangedPayload = Readonly<{ doc: string }>;
type DocSnapshotPayload = Readonly<{ requestId: string; doc: string }>;
type OpenLinkPayload = Readonly<{ href: string }>;
type SelectionStatePayload = MarkdownSelectionState;

type MenuTriggerChangedPayload = MenuTriggerState | null;
type MenuTriggerKeyDownPayload = MenuTriggerKeyDownEvent;
type LinkBubbleChangedPayload = LinkBubbleState | null;

type InboundEnvelope =
    | Readonly<{ v: 1; type: 'ready'; payload: unknown }>
    | Readonly<{ v: 1; type: 'docChanged'; payload: DocChangedPayload }>
    | Readonly<{ v: 1; type: 'docSnapshot'; payload: DocSnapshotPayload }>
    | Readonly<{ v: 1; type: 'selectionState'; payload: SelectionStatePayload }>
    | Readonly<{ v: 1; type: 'menuTriggerChanged'; payload: MenuTriggerChangedPayload }>
    | Readonly<{ v: 1; type: 'menuTriggerKeyDown'; payload: MenuTriggerKeyDownPayload }>
    | Readonly<{ v: 1; type: 'linkBubbleChanged'; payload: LinkBubbleChangedPayload }>
    | Readonly<{ v: 1; type: 'openLink'; payload: OpenLinkPayload }>
    | Readonly<{ v: 1; type: 'error'; payload: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asDocChangedPayload(payload: unknown): DocChangedPayload | null {
    if (!isRecord(payload) || typeof payload.doc !== 'string') return null;
    return { doc: payload.doc };
}

function asDocSnapshotPayload(payload: unknown): DocSnapshotPayload | null {
    if (!isRecord(payload)) return null;
    const { requestId, doc } = payload;
    if (typeof requestId !== 'string' || !requestId || typeof doc !== 'string') return null;
    return { requestId, doc };
}

function asOpenLinkPayload(payload: unknown): OpenLinkPayload | null {
    if (!isRecord(payload) || typeof payload.href !== 'string') return null;
    return { href: payload.href };
}

/**
 * Parse guard for `menuTriggerChanged` envelope payload (Lane F).
 * Validates the full `MenuTriggerState` shape or returns `null` for dismissal.
 */
function asMenuTriggerChangedPayload(payload: unknown): MenuTriggerChangedPayload | undefined {
    // `null` payload means the trigger was dismissed.
    if (payload === null) return null;
    if (!isRecord(payload)) return undefined;
    if (payload.kind !== 'slash') return undefined;
    if (typeof payload.query !== 'string') return undefined;
    if (typeof payload.from !== 'number') return undefined;
    if (typeof payload.to !== 'number') return undefined;
    const caretRect = payload.caretRect;
    if (!isRecord(caretRect)) return undefined;
    if (typeof caretRect.left !== 'number') return undefined;
    if (typeof caretRect.top !== 'number') return undefined;
    if (typeof caretRect.height !== 'number') return undefined;
    return {
        kind: 'slash',
        query: payload.query as string,
        from: payload.from as number,
        to: payload.to as number,
        caretRect: {
            left: caretRect.left as number,
            top: caretRect.top as number,
            height: caretRect.height as number,
        },
    };
}

function asMenuTriggerKeyDownPayload(payload: unknown): MenuTriggerKeyDownPayload | null {
    if (!isRecord(payload)) return null;
    const key = payload.key;
    if (
        key !== 'ArrowDown'
        && key !== 'ArrowUp'
        && key !== 'Enter'
        && key !== 'Tab'
        && key !== 'Escape'
    ) {
        return null;
    }
    const trigger = asMenuTriggerChangedPayload(payload.trigger);
    if (!trigger) return null;
    return { key, trigger };
}

/**
 * Parse guard for `linkBubbleChanged` envelope payload (Lane H).
 * Validates the full `LinkBubbleState` shape or returns `null` for dismissal.
 * Mirrors `asMenuTriggerChangedPayload`: `undefined` = malformed, `null` = valid
 * dismissal.
 */
function asLinkBubbleChangedPayload(payload: unknown): LinkBubbleChangedPayload | undefined {
    if (payload === null) return null;
    if (!isRecord(payload)) return undefined;
    if (typeof payload.href !== 'string') return undefined;
    const caretRect = payload.caretRect;
    if (!isRecord(caretRect)) return undefined;
    if (typeof caretRect.left !== 'number') return undefined;
    if (typeof caretRect.top !== 'number') return undefined;
    if (typeof caretRect.height !== 'number') return undefined;
    return {
        href: payload.href as string,
        caretRect: {
            left: caretRect.left as number,
            top: caretRect.top as number,
            height: caretRect.height as number,
        },
    };
}

const MARKDOWN_BLOCK_TYPES: ReadonlySet<MarkdownBlockType> = new Set<MarkdownBlockType>([
    'paragraph',
    'heading1',
    'heading2',
    'heading3',
    'bulletList',
    'orderedList',
    'taskList',
    'blockquote',
    'codeBlock',
]);

function isBooleanMarks(value: unknown): value is MarkdownSelectionState['marks'] {
    if (!isRecord(value)) return false;
    return (
        typeof value.bold === 'boolean' &&
        typeof value.italic === 'boolean' &&
        typeof value.strike === 'boolean' &&
        typeof value.code === 'boolean'
    );
}

function asSelectionStatePayload(payload: unknown): SelectionStatePayload | null {
    if (!isRecord(payload)) return null;
    const { marks, blockType, isLinkActive, linkHref, canUndo, canRedo } = payload;
    if (!isBooleanMarks(marks)) return null;
    if (typeof blockType !== 'string' || !MARKDOWN_BLOCK_TYPES.has(blockType as MarkdownBlockType)) return null;
    if (typeof isLinkActive !== 'boolean' || typeof canUndo !== 'boolean' || typeof canRedo !== 'boolean') return null;
    if (linkHref !== undefined && typeof linkHref !== 'string') return null;
    return {
        marks: { bold: marks.bold, italic: marks.italic, strike: marks.strike, code: marks.code },
        blockType: blockType as MarkdownBlockType,
        isLinkActive,
        ...(typeof linkHref === 'string' ? { linkHref } : {}),
        canUndo,
        canRedo,
    };
}

/**
 * Validate a transport envelope (whose `payload` is `unknown`) into a typed
 * {@link InboundEnvelope}, or `null` when the type/payload shape is malformed or
 * unrecognized. `ready`/`error` carry no host-consumed fields so their payloads
 * stay opaque; the others are narrowed via the per-type guards above so a
 * partial/garbage payload from the WebView bundle can never reach subscribers.
 */
function parseInboundEnvelope(decoded: WebViewBridgeEnvelopeV1): InboundEnvelope | null {
    switch (decoded.type) {
        case 'ready':
            return { v: 1, type: 'ready', payload: decoded.payload };
        case 'error':
            return { v: 1, type: 'error', payload: decoded.payload };
        case 'docChanged': {
            const payload = asDocChangedPayload(decoded.payload);
            return payload ? { v: 1, type: 'docChanged', payload } : null;
        }
        case 'docSnapshot': {
            const payload = asDocSnapshotPayload(decoded.payload);
            return payload ? { v: 1, type: 'docSnapshot', payload } : null;
        }
        case 'selectionState': {
            const payload = asSelectionStatePayload(decoded.payload);
            return payload ? { v: 1, type: 'selectionState', payload } : null;
        }
        case 'menuTriggerChanged': {
            const payload = asMenuTriggerChangedPayload(decoded.payload);
            // `undefined` means malformed payload → ignore the envelope.
            // `null` means valid dismissal → forward to subscribers.
            return payload !== undefined
                ? { v: 1, type: 'menuTriggerChanged', payload }
                : null;
        }
        case 'menuTriggerKeyDown': {
            const payload = asMenuTriggerKeyDownPayload(decoded.payload);
            return payload ? { v: 1, type: 'menuTriggerKeyDown', payload } : null;
        }
        case 'linkBubbleChanged': {
            const payload = asLinkBubbleChangedPayload(decoded.payload);
            return payload !== undefined
                ? { v: 1, type: 'linkBubbleChanged', payload }
                : null;
        }
        case 'openLink': {
            const payload = asOpenLinkPayload(decoded.payload);
            return payload ? { v: 1, type: 'openLink', payload } : null;
        }
        default:
            return null;
    }
}

const DEFAULT_CHANGE_DEBOUNCE_MS = 250;
const DEFAULT_MAX_CHUNK_BYTES = 64_000;
const FLUSH_TIMEOUT_MS = 1500;

function createNeutralSelectionState(): MarkdownSelectionState {
    return {
        marks: { bold: false, italic: false, strike: false, code: false },
        blockType: 'paragraph',
        isLinkActive: false,
        canUndo: false,
        canRedo: false,
    };
}

/** Request-id generator for the `requestDoc`/`docSnapshot` flush handshake. */
function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

export const TiptapWebViewSurface = React.forwardRef<MarkdownEditorSurfaceRef, MarkdownEditorProps>(
    function TiptapWebViewSurface(props, ref) {
        const { theme } = useUnistyles();
        const uiFontScale = useLocalSetting('uiFontScale');

        const readOnly = props.readOnly ?? false;
        const changeDebounceMs =
            typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : DEFAULT_CHANGE_DEBOUNCE_MS;
        const maxChunkBytes =
            typeof props.bridgeMaxChunkBytes === 'number' ? props.bridgeMaxChunkBytes : DEFAULT_MAX_CHUNK_BYTES;

        const webViewTheme = React.useMemo(
            () => resolveMarkdownEditorTheme(theme),
            [
                theme.dark,
                theme.colors.surface.inset,
                theme.colors.surface.elevated,
                theme.colors.text.primary,
                theme.colors.text.secondary,
                theme.colors.text.link,
                theme.colors.border.default,
                theme.colors.state.active.background,
                theme.colors.state.active.foreground,
            ],
        );

        // The surface tracks its OWN readiness flag rather than the messenger's
        // one-shot `onReady`: on a `resetKey` remount the `<WebView>` is replaced
        // (via `key`) and re-emits `ready`, and we must re-send `init` each time.
        // We therefore handle the `ready` envelope inside `handleEnvelope` (fed by
        // the messenger's `onEnvelope`, which fires for EVERY decoded envelope incl.
        // `ready`) and reset this flag on resetKey. The messenger owns only the
        // chunked transport + decode/dispatch (D8/R-A5).
        const readyRef = React.useRef(false);
        const pendingInitRef = React.useRef<null | { doc: string }>(null);
        // Synchronous mirror of the current document (R5) + the latest content the
        // fallback path hands to `onUnavailable` (R-A17).
        const lastDocRef = React.useRef(props.value);
        const pendingDocRequestRef = React.useRef(
            new Map<string, { resolve: () => void; timeoutId: ReturnType<typeof setTimeout> }>(),
        );
        const latestReadOnlyRef = React.useRef(readOnly);
        latestReadOnlyRef.current = readOnly;

        // Selection subscribers for the controller. The latest state is replayed to
        // new subscribers so a toolbar mounting after a selection still reflects it.
        const selectionSubscribersRef = React.useRef(new Set<(state: MarkdownSelectionState) => void>());
        const lastSelectionStateRef = React.useRef<MarkdownSelectionState | null>(null);

        // Lane F: menu trigger subscribers.
        const menuTriggerSubscribersRef = React.useRef(new Set<(state: MenuTriggerState | null) => void>());
        const menuKeyDownSubscribersRef = React.useRef(new Set<(event: MenuTriggerKeyDownEvent) => boolean>());
        // Lane H: link bubble subscribers + last-known state for replay.
        const linkBubbleSubscribersRef = React.useRef(new Set<(state: LinkBubbleState | null) => void>());
        const lastLinkBubbleStateRef = React.useRef<LinkBubbleState | null>(null);
        // Lane F: viewport layout subscribers (D40).
        const viewportLayoutSubscribersRef = React.useRef(new Set<(rect: EditorViewportWindowRect | null) => void>());
        const lastViewportLayoutRef = React.useRef<EditorViewportWindowRect | null>(null);
        // Ref to the outer View for measuring the WebView viewport in window coords.
        const outerViewRef = React.useRef<View>(null);

        // Keep the latest prop callbacks in refs so the message handler stays stable.
        const onChangeRef = React.useRef(props.onChange);
        const onUnavailableRef = React.useRef(props.onUnavailable);
        onChangeRef.current = props.onChange;
        onUnavailableRef.current = props.onUnavailable;

        const html = React.useMemo(
            () =>
                buildTiptapWebViewHtml({
                    theme: webViewTheme,
                    readOnly,
                    changeDebounceMs,
                    maxChunkBytes,
                    uiFontScale,
                    osFontScale: typeof PixelRatio.getFontScale === 'function' ? PixelRatio.getFontScale() : 1,
                }),
            [webViewTheme, readOnly, changeDebounceMs, maxChunkBytes, uiFontScale],
        );

        // Forward ref to `handleEnvelope` (defined below). The messenger reads its
        // `onEnvelope` callback fresh on every inbound message, so wiring through a
        // ref keeps the messenger identity stable while always dispatching to the
        // latest handler.
        const handleEnvelopeRef = React.useRef<(decoded: WebViewBridgeEnvelopeV1) => void>(() => {});

        // D8/R-A5: the shared messenger owns the chunked encode/post + decode/
        // dispatch. We do NOT use its one-shot `onReady` (see `readyRef` note); the
        // `ready` envelope is handled in `handleEnvelope` via `onEnvelope` so init
        // re-sends on every resetKey remount. The wire format stays byte-identical:
        // the hook encodes through the same `chunkedBridge` with the same
        // `maxChunkBytes` + the same default base-36 message-id generator.
        const messenger = useWebViewBridgeMessenger({
            maxChunkBytes,
            onEnvelope: (decoded) => handleEnvelopeRef.current(decoded),
        });

        const postEnvelope = React.useCallback(
            (envelope: WebViewBridgeEnvelopeV1) => {
                messenger.postEnvelope(envelope);
            },
            [messenger],
        );

        const sendInit = React.useCallback(() => {
            if (!readyRef.current) return;
            const doc = pendingInitRef.current?.doc ?? lastDocRef.current;
            pendingInitRef.current = null;
            lastDocRef.current = doc;
            postEnvelope({
                v: 1,
                type: 'init',
                payload: { doc, readOnly: latestReadOnlyRef.current },
            });
        }, [postEnvelope]);

        const flushPendingChange = React.useCallback(async (): Promise<void> => {
            if (!readyRef.current) return;
            const requestId = createMessageId();
            return await new Promise<void>((resolve) => {
                const timeoutId = setTimeout(() => {
                    pendingDocRequestRef.current.delete(requestId);
                    resolve();
                }, FLUSH_TIMEOUT_MS);
                pendingDocRequestRef.current.set(requestId, { resolve, timeoutId });
                postEnvelope({ v: 1, type: 'requestDoc', payload: { requestId } });
            });
        }, [postEnvelope]);

        const runCommand = React.useCallback(
            (command: MarkdownEditorCommand) => {
                const { kind, ...args } = command;
                postEnvelope({ v: 1, type: 'command', payload: { name: kind, args } });
            },
            [postEnvelope],
        );

        const subscribeSelection = React.useCallback(
            (callback: (state: MarkdownSelectionState) => void) => {
                selectionSubscribersRef.current.add(callback);
                // Replay the latest known selection so the subscriber starts in sync.
                if (lastSelectionStateRef.current) {
                    callback(lastSelectionStateRef.current);
                }
                return () => {
                    selectionSubscribersRef.current.delete(callback);
                };
            },
            [],
        );

        // Lane F: subscribe to menu trigger state changes.
        const subscribeMenuTrigger = React.useCallback(
            (callback: (state: MenuTriggerState | null) => void) => {
                menuTriggerSubscribersRef.current.add(callback);
                return () => {
                    menuTriggerSubscribersRef.current.delete(callback);
                };
            },
            [],
        );

        const subscribeMenuKeyDown = React.useCallback(
            (callback: (event: MenuTriggerKeyDownEvent) => boolean) => {
                menuKeyDownSubscribersRef.current.add(callback);
                return () => {
                    menuKeyDownSubscribersRef.current.delete(callback);
                };
            },
            [],
        );

        // Lane H: subscribe to link bubble state changes.
        const subscribeLinkBubble = React.useCallback(
            (callback: (state: LinkBubbleState | null) => void) => {
                linkBubbleSubscribersRef.current.add(callback);
                // Replay the last known state so a subscriber mounted after a
                // link became active reflects it.
                callback(lastLinkBubbleStateRef.current);
                return () => {
                    linkBubbleSubscribersRef.current.delete(callback);
                };
            },
            [],
        );

        // Lane F: run a slash menu command. Posts the existing `command` envelope
        // with optional `deleteRange` — the WebView entry handles deletion before
        // command dispatch (D8).
        const runMenuCommand = React.useCallback(
            (command: MarkdownEditorCommand, deleteRange?: { from: number; to: number }) => {
                const { kind, ...args } = command;
                postEnvelope({
                    v: 1,
                    type: 'command',
                    payload: {
                        name: kind,
                        args,
                        ...(deleteRange ? { deleteRange } : {}),
                    },
                });
            },
            [postEnvelope],
        );

        // D40: subscribe to editor viewport layout changes.
        const subscribeEditorViewportLayout = React.useCallback(
            (callback: (rect: EditorViewportWindowRect | null) => void) => {
                viewportLayoutSubscribersRef.current.add(callback);
                // Replay the latest layout immediately.
                if (lastViewportLayoutRef.current) {
                    callback(lastViewportLayoutRef.current);
                }
                return () => {
                    viewportLayoutSubscribersRef.current.delete(callback);
                };
            },
            [],
        );

        // D40: one-shot measurement of the editor viewport in window coordinates.
        const measureEditorViewportInWindow = React.useCallback(
            (): Promise<EditorViewportWindowRect | null> => {
                return new Promise<EditorViewportWindowRect | null>((resolve) => {
                    const view = outerViewRef.current;
                    if (!view) {
                        resolve(null);
                        return;
                    }
                    view.measureInWindow((x, y, width, height) => {
                        if (width === 0 && height === 0) {
                            resolve(null);
                            return;
                        }
                        resolve({ left: x, top: y, width, height });
                    });
                });
            },
            [],
        );

        // D40: handle outer View layout changes to update viewport rect subscribers.
        const handleViewLayout = React.useCallback(() => {
            const view = outerViewRef.current;
            if (!view) return;
            view.measureInWindow((x, y, width, height) => {
                if (width === 0 && height === 0) return;
                const rect: EditorViewportWindowRect = { left: x, top: y, width, height };
                lastViewportLayoutRef.current = rect;
                for (const subscriber of viewportLayoutSubscribersRef.current) {
                    subscriber(rect);
                }
            });
        }, []);

        React.useImperativeHandle(
            ref,
            () => ({
                getValue: () => lastDocRef.current,
                flushPendingChange,
                runCommand,
                subscribeSelection,
                subscribeMenuTrigger,
                subscribeMenuKeyDown,
                runMenuCommand,
                subscribeEditorViewportLayout,
                measureEditorViewportInWindow,
                subscribeLinkBubble,
            }),
            [flushPendingChange, runCommand, subscribeSelection, subscribeMenuTrigger, subscribeMenuKeyDown, runMenuCommand, subscribeEditorViewportLayout, measureEditorViewportInWindow, subscribeLinkBubble],
        );

        const clearPendingDocRequests = React.useCallback(() => {
            for (const pending of pendingDocRequestRef.current.values()) {
                clearTimeout(pending.timeoutId);
                pending.resolve();
            }
            pendingDocRequestRef.current.clear();
        }, []);

        React.useEffect(() => {
            readyRef.current = false;
            pendingInitRef.current = { doc: lastDocRef.current };
            lastSelectionStateRef.current = null;
            const resetSelectionState = createNeutralSelectionState();
            for (const subscriber of selectionSubscribersRef.current) {
                subscriber(resetSelectionState);
            }
            // Lane F: dismiss any active menu trigger on reset.
            for (const subscriber of menuTriggerSubscribersRef.current) {
                subscriber(null);
            }
            // Lane H: dismiss any active link bubble on reset.
            lastLinkBubbleStateRef.current = null;
            for (const subscriber of linkBubbleSubscribersRef.current) {
                subscriber(null);
            }
            clearPendingDocRequests();
        }, [props.resetKey, clearPendingDocRequests]);

        React.useEffect(() => {
            return () => {
                clearPendingDocRequests();
            };
        }, [clearPendingDocRequests]);

        // External value change while mounted: reseed (after ready) or stage it.
        React.useEffect(() => {
            if (lastDocRef.current === props.value) return;
            pendingInitRef.current = { doc: props.value };
            lastDocRef.current = props.value;
            if (readyRef.current) {
                postEnvelope({ v: 1, type: 'setDoc', payload: { doc: props.value } });
            }
        }, [props.value, postEnvelope]);

        // Re-send init when readOnly toggles after ready (mirrors CodeMirror).
        React.useEffect(() => {
            if (!readyRef.current) return;
            sendInit();
        }, [readOnly, sendInit]);

        const handleEnvelope = React.useCallback(
            (decoded: WebViewBridgeEnvelopeV1) => {
                // Validate the boundary payload up-front: unrecognized types and
                // malformed/partial payloads become `null` and are ignored here, so
                // only well-formed envelopes flow to subscribers below.
                const envelope = parseInboundEnvelope(decoded);
                if (!envelope) return;

                switch (envelope.type) {
                    case 'ready': {
                        readyRef.current = true;
                        sendInit();
                        return;
                    }

                    case 'docChanged': {
                        lastDocRef.current = envelope.payload.doc;
                        onChangeRef.current(envelope.payload.doc);
                        return;
                    }

                    case 'docSnapshot': {
                        lastDocRef.current = envelope.payload.doc;
                        onChangeRef.current(envelope.payload.doc);

                        const pending = pendingDocRequestRef.current.get(envelope.payload.requestId);
                        if (pending) {
                            pendingDocRequestRef.current.delete(envelope.payload.requestId);
                            clearTimeout(pending.timeoutId);
                            pending.resolve();
                        }
                        return;
                    }

                    case 'selectionState': {
                        const state = envelope.payload;
                        lastSelectionStateRef.current = state;
                        for (const subscriber of selectionSubscribersRef.current) {
                            subscriber(state);
                        }
                        return;
                    }

                    case 'menuTriggerChanged': {
                        const triggerState = envelope.payload;
                        for (const subscriber of menuTriggerSubscribersRef.current) {
                            subscriber(triggerState);
                        }
                        return;
                    }

                    case 'menuTriggerKeyDown': {
                        for (const subscriber of menuKeyDownSubscribersRef.current) {
                            subscriber(envelope.payload);
                        }
                        return;
                    }

                    case 'linkBubbleChanged': {
                        const bubbleState = envelope.payload;
                        lastLinkBubbleStateRef.current = bubbleState;
                        for (const subscriber of linkBubbleSubscribersRef.current) {
                            subscriber(bubbleState);
                        }
                        return;
                    }

                    case 'openLink': {
                        // The headless WebView must not navigate itself; it bounces
                        // the resolved href to the host. Open only the TipTap-
                        // allowed absolute schemes the native host can actually
                        // hand to `Linking` (reject relative/javascript/file/etc).
                        const href = resolveNativeOpenableMarkdownHref(envelope.payload.href);
                        if (href) {
                            void Linking.openURL(href).catch(() => {
                                /* unsupported/invalid URL — ignore */
                            });
                        }
                        return;
                    }

                    case 'error': {
                        // D9/R-A4/R-A17: no CDN fallback. Hand the freshest markdown
                        // directly to the parent so it can seed raw mode synchronously
                        // — do NOT rely on a separate batched `onChange`.
                        onUnavailableRef.current?.(lastDocRef.current);
                        return;
                    }
                }
            },
            [sendInit],
        );

        // Keep the messenger's `onEnvelope` pointed at the latest handler.
        handleEnvelopeRef.current = handleEnvelope;

        return (
            <View
                ref={outerViewRef}
                testID={props.testID}
                onLayout={handleViewLayout}
                style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor: webViewTheme.dividerColor,
                    borderRadius: 10,
                    overflow: 'hidden',
                    backgroundColor: webViewTheme.backgroundColor,
                }}
            >
                <WebView
                    key={props.resetKey}
                    ref={messenger.webViewRef}
                    source={{ html }}
                    style={{ flex: 1 }}
                    onMessage={messenger.onMessage}
                />
            </View>
        );
    },
);
