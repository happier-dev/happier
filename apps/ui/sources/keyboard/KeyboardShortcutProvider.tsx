import { ShortcutsSheet } from './shortcutsSheet/ShortcutsSheet';
import * as React from 'react';
import type { HappierFindBarProps } from '@happier-dev/plugin-ui/presentation';
import { useFindSurfaceRegistrationWithHost, type FindSurfaceRegistrationHost } from '@happier-dev/plugin-ui/advanced';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { FocusReturnProvider } from './focusReturn';
import { KeyboardShortcutLabelsContext, NO_KEYBOARD_SHORTCUT_LABELS } from './shortcutLabels';
import {
    buildKeyboardShortcutLabels,
    buildNativeConsumableSignature,
    createKeyboardShortcutDispatcher,
    hasAnyAvailableKeyboardHandler,
    isFindKeyboardCommand,
    isKeyboardTargetHidden,
    normalizeKeyboardEvent,
    normalizeNativeHardwareKeyboardEvent,
    readKeyboardContextFromEventTarget,
    resolveNativeHardwareKeyboardConsumableEventSignatures,
    resolveKeyboardPlatform,
    type KeyboardShortcutHandlers,
    type NativeHardwareKeyboardEventLike,
} from './runtime';
import type { KeyboardCommandId, KeyboardSurface, KeybindingRule, NormalizedKeyboardEvent } from './types';
import * as nativeKeyboardBridge from '@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { createFindSurfaceRegistry, type FindSurfaceRegistration, type FindSurfaceRegistry } from './findSurfaceRegistry';
import { registerFindActionRuntime } from './findActionRuntime';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from './escape';
import { focusPaneRegion } from '@/components/appShell/panes/paneRegionFocus';
import { selectEmbeddedKeyboardHandlers } from './embeddedKeyboard';

type NativeKeyboardBridgeModule = typeof nativeKeyboardBridge & Readonly<{
    subscribeToNativeHardwareKeyboardEvents?: (
        listener: (event: NativeHardwareKeyboardEventLike) => void,
    ) => { remove(): void } | null;
}>;

type KeyboardShortcutRegistrationContextValue = Readonly<{
    registerHandlers: (handlers: KeyboardShortcutHandlers, nativeInput?: NativeKeyboardInputRegistration) => () => void;
    executeCommand: (commandId: KeyboardCommandId) => boolean;
    submitFindInput: () => boolean;
    find: FindSurfaceRegistry;
    refreshFindAvailability: () => void;
}>;

type NativeKeyboardInputRegistration = Readonly<{
    bindings: readonly string[];
    handleKey: (event: NormalizedKeyboardEvent) => boolean;
}>;

const KeyboardShortcutRegistrationContext = React.createContext<KeyboardShortcutRegistrationContextValue | null>(null);
type EmbeddedKeyboardChannel = Readonly<{
    signatures: readonly string[];
    dispatch(event: NativeHardwareKeyboardEventLike): boolean;
}>;
const EmbeddedKeyboardContext = React.createContext<Readonly<{
    find: EmbeddedKeyboardChannel;
    editor: EmbeddedKeyboardChannel;
    browser: EmbeddedKeyboardChannel;
}> | null>(null);

export type KeyboardShortcutContextSnapshot = Readonly<{
    registration: KeyboardShortcutRegistrationContextValue | null;
    labels: React.ContextType<typeof KeyboardShortcutLabelsContext>;
}>;

/** Modal hosts outside the caller's subtree keep using its one keyboard runtime. */
export function useKeyboardShortcutContextSnapshot(): KeyboardShortcutContextSnapshot {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    const labels = React.useContext(KeyboardShortcutLabelsContext);
    return React.useMemo(() => ({ registration, labels }), [registration, labels]);
}

/** Replays context only; listeners, preferences and command dispatch remain provider-owned. */
export function KeyboardShortcutContextBridge(props: React.PropsWithChildren<Readonly<{
    snapshot: KeyboardShortcutContextSnapshot;
}>>): React.ReactElement {
    return <KeyboardShortcutRegistrationContext.Provider value={props.snapshot.registration}>
        <KeyboardShortcutLabelsContext.Provider value={props.snapshot.labels}>
            {props.children}
        </KeyboardShortcutLabelsContext.Provider>
    </KeyboardShortcutRegistrationContext.Provider>;
}

const HANDLER_KEY_SIGNATURE_SEPARATOR = '\u0000';

function buildHandlerKeySignature(handlers: KeyboardShortcutHandlers): string {
    return Object.keys(handlers).sort().join(HANDLER_KEY_SIGNATURE_SEPARATOR);
}

function buildSignatureListKey(signatures: readonly string[]): string {
    return [...signatures].sort().join(HANDLER_KEY_SIGNATURE_SEPARATOR);
}

function buildKeybindingRuleSignature(rule: KeybindingRule): string {
    return [
        rule.binding,
        buildSignatureListKey(rule.platforms ?? []),
        buildSignatureListKey(rule.blockedSurfaces ?? []),
        rule.webHost ?? '',
        rule.allowInEditable == null ? '' : String(rule.allowInEditable),
        rule.nativeConsumable == null ? '' : String(rule.nativeConsumable),
        rule.conflictScope ?? '',
    ].join(HANDLER_KEY_SIGNATURE_SEPARATOR);
}

function buildKeyboardShortcutOverridesSignature(
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>,
): string {
    return Object.keys(overrides)
        .sort()
        .map((commandId) => [
            commandId,
            ...overrides[commandId].map(buildKeybindingRuleSignature),
        ].join(HANDLER_KEY_SIGNATURE_SEPARATOR))
        .join(HANDLER_KEY_SIGNATURE_SEPARATOR);
}

export function useKeyboardShortcutHandlers(handlers: KeyboardShortcutHandlers): boolean {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    const latestHandlersRef = React.useRef(handlers);
    latestHandlersRef.current = handlers;
    const handlerKeySignature = buildHandlerKeySignature(handlers);
    const registeredHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        if (!handlerKeySignature) return {};
        const next: KeyboardShortcutHandlers = {};
        const keys = handlerKeySignature.split(HANDLER_KEY_SIGNATURE_SEPARATOR) as KeyboardCommandId[];
        for (const key of keys) {
            if (isFindKeyboardCommand(key)) next[key] = (event) => latestHandlersRef.current[key]?.(event);
            else next[key] = () => latestHandlersRef.current[key]?.();
        }
        return next;
    }, [handlerKeySignature]);

    React.useEffect(() => {
        if (!registration) return;
        if (!handlerKeySignature) return;
        return registration.registerHandlers(registeredHandlers);
    }, [handlerKeySignature, registeredHandlers, registration]);

    return registration != null;
}

/** Explicit UI actions share command handlers without depending on keyboard binding preferences. */
export function useKeyboardCommand(): (commandId: KeyboardCommandId) => boolean {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    return React.useCallback((commandId: KeyboardCommandId) => registration?.executeCommand(commandId) ?? false, [registration]);
}

/** Focused native fields share the provider's bridge subscription and consumption configuration. */
export function useNativeKeyboardInput(input: NativeKeyboardInputRegistration | null): void {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    const latest = React.useRef(input);
    latest.current = input;
    const bindingsKey = input?.bindings.join(HANDLER_KEY_SIGNATURE_SEPARATOR);
    React.useEffect(() => {
        if (Platform.OS === 'web' || !registration || !bindingsKey) return;
        return registration.registerHandlers({}, {
            bindings: bindingsKey.split(HANDLER_KEY_SIGNATURE_SEPARATOR),
            handleKey: (event) => latest.current?.handleKey(event) ?? false,
        });
    }, [registration, bindingsKey]);
}

export function useFindSurfaceRegistration(surface: FindSurfaceRegistration | null): void {
    useFindSurfaceRegistrationWithHost(surface, useFindSurfaceRegistrationHost());
}

/** The plugin presentation adapter forwards registrations into this provider's one owner. */
export function useFindSurfaceRegistrationHost(): FindSurfaceRegistrationHost | null {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    const find = registration?.find;
    const refresh = registration?.refreshFindAvailability;
    return React.useMemo(() => find && refresh ? { register: find.register, refresh } : null, [find, refresh]);
}

/** Menu intents are independent of keyboard preference disablement. */
export function useFindSurfaceRuntime(): Readonly<{
    open(surfaceId?: string): boolean;
    keyboardHandlers: HappierFindBarProps['keyboardHandlers'];
}> {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    return React.useMemo(() => ({
        open: (surfaceId?: string) => registration?.find.open(surfaceId) ?? false,
        keyboardHandlers: registration ? {
            // Physical keys belong to the web capture listener or native hardware bridge.
            onKeyPress: () => undefined,
            onSubmitEditing: () => { registration.submitFindInput(); },
        } : undefined,
    }), [registration]);
}

/** Embedded renderers consume only the provider's configured Find chords before PTY delivery. */
export function useEmbeddedFindKeyboard(): Readonly<{
    signatures: readonly string[];
    dispatch(event: NativeHardwareKeyboardEventLike): boolean;
}> {
    return React.useContext(EmbeddedKeyboardContext)?.find ?? EMPTY_EMBEDDED_KEYBOARD;
}

/** Code editors forward configured Find, Save and Ask chords through the same host dispatcher. */
export function useEmbeddedEditorKeyboard(): EmbeddedKeyboardChannel {
    return React.useContext(EmbeddedKeyboardContext)?.editor ?? EMPTY_EMBEDDED_KEYBOARD;
}
/** Browser guests forward the effective browser bindings, never a second shortcut registry. */
export function useEmbeddedBrowserKeyboard(): EmbeddedKeyboardChannel {
    return React.useContext(EmbeddedKeyboardContext)?.browser ?? EMPTY_EMBEDDED_KEYBOARD;
}
const EMPTY_EMBEDDED_KEYBOARD: EmbeddedKeyboardChannel = { signatures: [], dispatch: () => false };


export function KeyboardShortcutProvider(props: React.PropsWithChildren<Readonly<{
    handlers: KeyboardShortcutHandlers;
    enabledWhenDisabledCommandIds?: readonly KeyboardCommandId[];
}>>) {
    const [find] = React.useState(createFindSurfaceRegistry);
    const [findAvailability, setFindAvailability] = React.useState({ available: false, open: false, inputFocused: false });
    const refreshFindAvailability = React.useCallback(() => {
        const resolved = find.resolve();
        const available = resolved !== undefined;
        const open = resolved?.isOpen() === true;
        const inputFocused = resolved?.isInputFocused() === true;
        setFindAvailability(current => current.available === available && current.open === open && current.inputFocused === inputFocused
            ? current : { available, open, inputFocused });
    }, [find]);
    React.useEffect(() => registerFindActionRuntime(find), [find]);
    const nextScopedHandlerIdRef = React.useRef(1);
    const [scopedHandlerEntries, setScopedHandlerEntries] = React.useState<ReadonlyMap<number, Readonly<{ handlers: KeyboardShortcutHandlers; nativeInput?: NativeKeyboardInputRegistration }>>>(
        () => new Map(),
    );
    const registerHandlers = React.useCallback((handlers: KeyboardShortcutHandlers, nativeInput?: NativeKeyboardInputRegistration) => {
        const id = nextScopedHandlerIdRef.current;
        nextScopedHandlerIdRef.current += 1;
        setScopedHandlerEntries((current) => {
            const next = new Map(current);
            next.set(id, { handlers, nativeInput });
            return next;
        });
        return () => {
            setScopedHandlerEntries((current) => {
                if (!current.has(id)) return current;
                const next = new Map(current);
                next.delete(id);
                return next;
            });
        };
    }, []);
    const scopedHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        const next: KeyboardShortcutHandlers = {};
        for (const entry of scopedHandlerEntries.values()) {
            Object.assign(next, entry.handlers);
        }
        return next;
    }, [scopedHandlerEntries]);
    const nativeInputs = React.useMemo(() => [...scopedHandlerEntries.values()]
        .flatMap((entry) => entry.nativeInput ? [entry.nativeInput] : []).reverse(), [scopedHandlerEntries]);
    const nativeInputsRef = React.useRef(nativeInputs);
    nativeInputsRef.current = nativeInputs;
    const propHandlers = props.handlers;
    const platform = React.useMemo(resolveKeyboardPlatform, []);
    const surface: KeyboardSurface = Platform.OS === 'web' ? 'web' : 'native';
    const webHost = isDesktopHost() ? 'desktop' as const : 'browser' as const;
    const {
        keyboardShortcutsV2Enabled,
        keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutOverridesV1,
        keyboardShortcutDisabledCommandIdsV1,
    } = storage(useShallow((state) => ({
        keyboardShortcutsV2Enabled: state.settings.keyboardShortcutsV2Enabled,
        keyboardSingleKeyShortcutsEnabled: state.settings.keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutOverridesV1: state.settings.keyboardShortcutOverridesV1,
        keyboardShortcutDisabledCommandIdsV1: state.settings.keyboardShortcutDisabledCommandIdsV1,
    })));
    const singleKeyShortcutsEnabled = keyboardSingleKeyShortcutsEnabled === true;
    // Find and Inbox navigation are local surface interactions. Their handlers
    // are present only while that surface owns focus; explicit per-command
    // disablement and the letter-key preference still apply.
    const enabledWhenDisabledCommandIds = React.useMemo<readonly KeyboardCommandId[]>(() => [
        ...(props.enabledWhenDisabledCommandIds ?? []), 'find.open', 'find.next', 'find.previous',
        'inbox.item.next', 'inbox.item.previous', 'inbox.item.open', 'inbox.item.close',
    ], [props.enabledWhenDisabledCommandIds]);
    const disabledCommandIds = keyboardShortcutDisabledCommandIdsV1 ?? [];
    const overrides = keyboardShortcutOverridesV1 ?? {};
    const defaultLabelContext = React.useMemo(() => ({
        isEditableTarget: false,
        isComposing: false,
    }), []);
    // Web always advertises Find; focus changes only its command-time destination.
    const findOpenAvailable = surface === 'web' || findAvailability.available;
    const findNavigationAvailable = surface === 'web' || findAvailability.open;
    const rootHandlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        'panes.region.next': () => focusPaneRegion('next') ? 'handled' : 'pass',
        'panes.region.previous': () => focusPaneRegion('previous') ? 'handled' : 'pass',
        ...(findOpenAvailable ? {
            'find.open': (event) => find.command('find.open', event),
        } satisfies KeyboardShortcutHandlers : {}),
        ...(findNavigationAvailable ? {
            'find.next': (event) => find.command('find.next', event),
            'find.previous': (event) => find.command('find.previous', event),
        } satisfies KeyboardShortcutHandlers : {}),
        ...propHandlers,
        ...scopedHandlers,
    }), [find, findOpenAvailable, findNavigationAvailable, propHandlers, scopedHandlers]);
    const labelHandlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...rootHandlers,
        'shortcutsHelp.open': () => undefined,
    }), [rootHandlers]);

    const shortcutLabels = React.useMemo(
        () => buildKeyboardShortcutLabels(platform, surface, {
            webHost,
            disabledCommandIds,
            overrides,
            singleKeyShortcutsEnabled,
            handlers: labelHandlers,
            context: defaultLabelContext,
        }),
        [defaultLabelContext, disabledCommandIds, labelHandlers, overrides, platform, singleKeyShortcutsEnabled, surface, webHost],
    );

    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...rootHandlers,
        'shortcutsHelp.open': () => {
            Modal.show({ component: ShortcutsSheet, props: {
                platform, host: webHost, singleKeyShortcutsEnabled, disabledCommandIds, overrides,
            } });
        },
    }), [disabledCommandIds, overrides, platform, rootHandlers, singleKeyShortcutsEnabled, webHost]);
    const handlerKeySignature = buildHandlerKeySignature(handlers);
    const nativeKeyboardConfigurationKey = React.useMemo(() => [
        keyboardShortcutsV2Enabled === true ? 'enabled' : 'disabled',
        buildSignatureListKey(enabledWhenDisabledCommandIds),
        platform,
        surface,
        singleKeyShortcutsEnabled === true ? 'single-key-on' : 'single-key-off',
        buildSignatureListKey(disabledCommandIds),
        buildKeyboardShortcutOverridesSignature(overrides),
        handlerKeySignature,
    ].join(HANDLER_KEY_SIGNATURE_SEPARATOR), [
        disabledCommandIds,
        handlerKeySignature,
        keyboardShortcutsV2Enabled,
        overrides,
        platform,
        enabledWhenDisabledCommandIds,
        singleKeyShortcutsEnabled,
        surface,
    ]);
    const dispatcherOptions = React.useMemo(() => ({
        enabled: keyboardShortcutsV2Enabled === true,
        enabledWhenDisabledCommandIds,
        platform,
        surface,
        webHost,
        singleKeyShortcutsEnabled,
        disabledCommandIds,
        overrides,
        handlers,
        getContext: () => ({
            isEditableTarget: false,
            isComposing: false,
            findInputFocused: find.resolve()?.isInputFocused() === true,
        }),
    }), [
        disabledCommandIds,
        find,
        handlers,
        keyboardShortcutsV2Enabled,
        overrides,
        platform,
        enabledWhenDisabledCommandIds,
        singleKeyShortcutsEnabled,
        surface,
        webHost,
    ]);
    const dispatcherOptionsRef = React.useRef(dispatcherOptions);
    dispatcherOptionsRef.current = dispatcherOptions;
    const executeCommand = React.useCallback((commandId: KeyboardCommandId): boolean => {
        const handler = dispatcherOptionsRef.current.handlers[commandId];
        if (!handler) return false;
        return handler() !== 'pass';
    }, []);
    const submitFindInput = React.useCallback((): boolean => {
        const currentOptions = dispatcherOptionsRef.current;
        const { 'find.next': next, 'find.previous': previous } = currentOptions.handlers;
        return createKeyboardShortcutDispatcher({
            ...currentOptions,
            handlers: { 'find.next': next, 'find.previous': previous },
            getContext: () => ({
                isEditableTarget: true,
                isComposing: false,
                findInputFocused: find.resolve()?.isInputFocused() === true,
            }),
        })(normalizeNativeHardwareKeyboardEvent({
            key: 'Enter', code: 'Enter', repeat: false,
            modifiers: { shift: false, ctrl: false, meta: false, alt: false },
        }));
    }, [find]);
    const embeddedKeyboard = React.useMemo(() => {
        const channel = (surface: 'find' | 'editor' | 'browser'): EmbeddedKeyboardChannel => {
            const options = { ...dispatcherOptions, handlers: selectEmbeddedKeyboardHandlers(dispatcherOptions.handlers, surface) };
            const signatures = [...resolveNativeHardwareKeyboardConsumableEventSignatures(options)];
            if (surface !== 'browser' && findAvailability.open) signatures.push('Escape|shift=false|ctrl=false|meta=false|alt=false');
            return { signatures, dispatch: (nativeEvent: NativeHardwareKeyboardEventLike) => {
                const event = normalizeNativeHardwareKeyboardEvent(nativeEvent);
                if (surface !== 'browser' && find.closeFromKeyboard(event) === 'handled') return true;
                const current = dispatcherOptionsRef.current;
                return createKeyboardShortcutDispatcher({ ...current,
                    handlers: selectEmbeddedKeyboardHandlers(current.handlers, surface),
                    getContext: () => ({ isEditableTarget: surface === 'browser' ? nativeEvent.isEditableTarget === true : true,
                        isComposing: event.isComposing, findInputFocused: find.resolve()?.isInputFocused() === true }),
                })(event);
            } };
        };
        return { find: channel('find'), editor: channel('editor'), browser: channel('browser') };
    }, [dispatcherOptions, find, findAvailability.open, findAvailability.inputFocused]);
    const registrationContextValue = React.useMemo<KeyboardShortcutRegistrationContextValue>(
        () => ({ registerHandlers, executeCommand, submitFindInput, find, refreshFindAvailability }),
        [registerHandlers, executeCommand, submitFindInput, find],
    );
    const nativeHardwareKeyboardRegistration = React.useMemo(() => {
        const hasAvailableHandler = hasAnyAvailableKeyboardHandler(dispatcherOptions) || nativeInputs.length > 0;
        const consumableEventSignatures = hasAvailableHandler
            ? [...resolveNativeHardwareKeyboardConsumableEventSignatures(dispatcherOptions)]
            : [];
        for (const input of nativeInputs) {
            for (const binding of input.bindings) {
                const signature = buildNativeConsumableSignature({ binding }, platform, true);
                if (signature) consumableEventSignatures.push(signature);
            }
        }
        if (findAvailability.open) {
            consumableEventSignatures.push('Escape|shift=false|ctrl=false|meta=false|alt=false');
        }
        return {
            consumableEventSignatures,
            key: hasAvailableHandler
                ? [
                    nativeKeyboardConfigurationKey,
                    buildSignatureListKey(consumableEventSignatures),
                ].join(HANDLER_KEY_SIGNATURE_SEPARATOR)
                : '',
        };
    }, [dispatcherOptions, findAvailability.open, findAvailability.inputFocused, nativeKeyboardConfigurationKey, nativeInputs, platform]);
    const nativeHardwareKeyboardRegistrationRef = React.useRef(nativeHardwareKeyboardRegistration);
    nativeHardwareKeyboardRegistrationRef.current = nativeHardwareKeyboardRegistration;

    useEscapeLayer({
        enabled: Platform.OS === 'web' && findAvailability.open,
        priority: ESCAPE_LAYER_PRIORITIES.find,
        allowEditableTarget: true,
        onEscape: (event) => find.closeFromKeyboard(normalizeKeyboardEvent(event as KeyboardEvent)) === 'handled',
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const dispatchEvent = (event: KeyboardEvent, captureEditor: boolean) => {
            if (event.defaultPrevented === true) return;
            const currentOptions = dispatcherOptionsRef.current;
            const editorHandlers = selectEmbeddedKeyboardHandlers(currentOptions.handlers, 'editor');
            const hiddenReviewTarget = captureEditor && isKeyboardTargetHidden(event.target);
            if (hiddenReviewTarget) {
                for (const id of Object.keys(currentOptions.handlers) as KeyboardCommandId[]) {
                    if (id.startsWith('review.')) editorHandlers[id] = currentOptions.handlers[id];
                }
            }
            const ordinaryHandlers = { ...currentOptions.handlers };
            for (const id of Object.keys(editorHandlers) as KeyboardCommandId[]) delete ordinaryHandlers[id];
            const dispatcher = createKeyboardShortcutDispatcher({
                ...currentOptions,
                handlers: captureEditor ? editorHandlers : ordinaryHandlers,
                getContext: () => ({
                    ...readKeyboardContextFromEventTarget(event.target),
                    ...(hiddenReviewTarget ? { isEditableTarget: false, isInteractiveTarget: false } : {}),
                    isComposing: event.isComposing === true,
                }),
            });
            const normalized = normalizeKeyboardEvent(event);
            if (!dispatcher(normalized)) return;
            event.preventDefault();
            event.stopPropagation();
            if (captureEditor) event.stopImmediatePropagation();
        };
        const captureEditor = (event: KeyboardEvent) => dispatchEvent(event, true);
        const handleKeyDown = (event: KeyboardEvent) => dispatchEvent(event, false);
        window.addEventListener('keydown', captureEditor, true);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('focusin', refreshFindAvailability);
        window.addEventListener('focusout', refreshFindAvailability);
        return () => {
            window.removeEventListener('keydown', captureEditor, true);
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('focusin', refreshFindAvailability);
            window.removeEventListener('focusout', refreshFindAvailability);
        };
    }, [find]);

    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        const bridge = nativeKeyboardBridge as NativeKeyboardBridgeModule;
        const subscribeToNativeHardwareKeyboardEvents = bridge.subscribeToNativeHardwareKeyboardEvents;
        if (!subscribeToNativeHardwareKeyboardEvents) return;

        if (!nativeHardwareKeyboardRegistration.key) return;
        const { consumableEventSignatures } = nativeHardwareKeyboardRegistrationRef.current;
        bridge.configureNativeHardwareKeyboardConsumableEventSignatures?.(
            consumableEventSignatures,
        );

        const subscription = subscribeToNativeHardwareKeyboardEvents((nativeEvent) => {
            const event = normalizeNativeHardwareKeyboardEvent(nativeEvent);
            if (nativeInputsRef.current.some((input) => input.handleKey(event))) return;
            const currentOptions = dispatcherOptionsRef.current;
            const dispatcher = createKeyboardShortcutDispatcher({
                ...currentOptions,
                getContext: () => ({
                    // Only an explicit native "not editable" fact may enable bindings
                    // that are unsafe in editors. Missing values from an older bridge
                    // fail closed until native focus ownership is known.
                    isEditableTarget: nativeEvent.isEditableTarget !== false,
                    isComposing: event.isComposing,
                }),
            });
            if (find.closeFromKeyboard(event) !== 'handled') dispatcher(event);
        });

        return () => {
            subscription?.remove();
            bridge.configureNativeHardwareKeyboardConsumableEventSignatures?.([]);
        };
    }, [nativeHardwareKeyboardRegistration.key]);

    return (
        <KeyboardShortcutRegistrationContext.Provider value={registrationContextValue}>
            <EmbeddedKeyboardContext.Provider value={embeddedKeyboard}>
            <KeyboardShortcutLabelsContext.Provider value={keyboardShortcutsV2Enabled === true ? shortcutLabels : NO_KEYBOARD_SHORTCUT_LABELS}>
                <FocusReturnProvider>{props.children}</FocusReturnProvider>
            </KeyboardShortcutLabelsContext.Provider>
            </EmbeddedKeyboardContext.Provider>
        </KeyboardShortcutRegistrationContext.Provider>
    );
}
