import { ShortcutsSheet } from './shortcutsSheet/ShortcutsSheet';
import * as React from 'react';
import { followSignal, type LayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { HappierFindBarProps } from '@happier-dev/plugin-ui/presentation';
import { useFindSurfaceRegistrationWithHost, type FindSurfaceRegistrationHost } from '@happier-dev/plugin-ui/advanced';
import { Platform } from 'react-native';

import { Modal } from '@/modal';
import { useLocalSetting, useSettingsValues } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { FocusReturnProvider } from './focusReturn';
import { KeyboardShortcutLabelsContext, NO_KEYBOARD_SHORTCUT_LABELS, type KeyboardShortcutLabels } from './shortcutLabels';
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
import { ESCAPE_LAYER_PRIORITIES, getMaxEscapeKeyBlockerPriority, useEscapeLayer } from './escape';
import { isComposerTypeToFocusKey } from './composer';
import { focusPaneRegion } from '@/components/appShell/panes/paneRegionFocus';
import { selectEmbeddedKeyboardHandlers } from './embeddedKeyboard';

type NativeKeyboardBridgeModule = typeof nativeKeyboardBridge & Readonly<{
    subscribeToNativeHardwareKeyboardEvents?: (
        listener: (event: NativeHardwareKeyboardEventLike) => void,
    ) => { remove(): void } | null;
}>;

type KeyboardShortcutRegistrationContextValue = Readonly<{
    labels: Pick<StoreApi<KeyboardShortcutLabels>, 'subscribe' | 'getState'>;
    registerHandlers: (handlers: KeyboardShortcutHandlers, nativeInput?: NativeKeyboardInputRegistration, context?: KeyboardShortcutHandlerContext) => () => void;
    executeCommand: (commandId: KeyboardCommandId) => boolean;
    isCommandAvailable: (commandId: KeyboardCommandId) => boolean;
    submitFindInput: () => boolean;
    find: FindSurfaceRegistry;
    refreshFindAvailability: () => void;
}>;

/** Native keyboard events identify an editable view; its mounted composer supplies focus ownership. */
type KeyboardShortcutHandlerContext = Readonly<{
    isComposerTarget?: boolean;
    /**
     * This registration owns its keys while it is registered (an open media stage, like the annotator's
     * tools): neither app-wide opt-in gates its commands. Every other registrant of the same commands stays gated.
     */
    ownsKeys?: boolean;
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
}>;

/** Modal hosts outside the caller's subtree keep using its one keyboard runtime. */
export function useKeyboardShortcutContextSnapshot(): KeyboardShortcutContextSnapshot {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    return React.useMemo(() => ({ registration }), [registration]);
}

const subscribeNoLabels = () => () => {};
const readNoLabels = () => NO_KEYBOARD_SHORTCUT_LABELS;

/** Bridges live labels and registration; keyboard listeners and preferences remain provider-owned. */
export function KeyboardShortcutContextBridge(props: React.PropsWithChildren<Readonly<{
    snapshot: KeyboardShortcutContextSnapshot;
}>>): React.ReactElement {
    const source = props.snapshot.registration?.labels;
    const labels = React.useSyncExternalStore(source?.subscribe ?? subscribeNoLabels,
        source?.getState ?? readNoLabels, source?.getState ?? readNoLabels);
    return <KeyboardShortcutRegistrationContext.Provider value={props.snapshot.registration}>
        <KeyboardShortcutLabelsContext.Provider value={labels}>
            {props.children}
        </KeyboardShortcutLabelsContext.Provider>
    </KeyboardShortcutRegistrationContext.Provider>;
}

const NO_DISABLED_COMMAND_IDS: readonly KeyboardCommandId[] = Object.freeze([]);
const NO_OWNED_COMMAND_IDS: readonly KeyboardCommandId[] = Object.freeze([]);
const NO_SHORTCUT_OVERRIDES: NonNullable<Parameters<typeof buildKeyboardShortcutLabels>[2]>['overrides'] = Object.freeze({});

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

export function useKeyboardShortcutHandlers(
    handlers: KeyboardShortcutHandlers,
    /**
     * The host's focus, followed by subscription: the handlers are registered only while it is true, and a
     * focus change re-registers without rendering the host. Absent means always.
     */
    active?: Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>,
    context?: KeyboardShortcutHandlerContext,
): boolean {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    const latestHandlersRef = React.useRef(handlers);
    latestHandlersRef.current = handlers;
    const handlerKeySignature = buildHandlerKeySignature(handlers);
    const isComposerTarget = context?.isComposerTarget;
    const ownsKeys = context?.ownsKeys === true;
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
        const handlerContext = isComposerTarget === undefined && !ownsKeys ? undefined
            : { ...(isComposerTarget === undefined ? {} : { isComposerTarget }), ...(ownsKeys ? { ownsKeys } : {}) };
        if (!active) return registration.registerHandlers(registeredHandlers, undefined, handlerContext);
        return followSignal(active, (isActive) => isActive ? registration.registerHandlers(registeredHandlers, undefined, handlerContext) : undefined);
    }, [active, handlerKeySignature, registeredHandlers, registration, isComposerTarget, ownsKeys]);

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

/**
 * Registers `surface` with the provider's Find owner. With `active`, the surface is registered only while
 * the signal is true, and it follows the signal by subscription: its owner does not render when it flips.
 */
export function useFindSurfaceRegistration(surface: FindSurfaceRegistration | null, active?: LayoutPresentationSignal): void {
    const host = useFindSurfaceRegistrationHost();
    const following = React.useMemo<FindSurfaceRegistrationHost | null>(() => host && active ? {
        register: (registration) => {
            let first = true;
            return followSignal(active, (on) => {
                const dispose = on ? host.register(registration) : undefined;
                // The registration hook refreshes after the first run; each later flip refreshes here.
                if (!first) host.refresh();
                first = false;
                return dispose;
            });
        },
        refresh: host.refresh,
    } : host, [active, host]);
    useFindSurfaceRegistrationWithHost(surface, following);
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
    open(surfaceId?: string, options?: Readonly<{ whenRegistered?: boolean }>): boolean;
    keyboardHandlers: HappierFindBarProps['keyboardHandlers'];
}> {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    return React.useMemo(() => ({
        open: (surfaceId?: string, options?: Readonly<{ whenRegistered?: boolean }>) => registration?.find.open(surfaceId, options) ?? false,
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
}>>) {
    // A modal opens before its handlers register. Publish the owner's live labels,
    // not an opening-time copy, across its out-of-tree context bridge.
    const [labels] = React.useState(() => createStore<KeyboardShortcutLabels>(() => NO_KEYBOARD_SHORTCUT_LABELS));
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
    const [scopedHandlerEntries, setScopedHandlerEntries] = React.useState<ReadonlyMap<number, Readonly<{ handlers: KeyboardShortcutHandlers; nativeInput?: NativeKeyboardInputRegistration; context?: KeyboardShortcutHandlerContext }>>>(
        () => new Map(),
    );
    const registerHandlers = React.useCallback((handlers: KeyboardShortcutHandlers, nativeInput?: NativeKeyboardInputRegistration, context?: KeyboardShortcutHandlerContext) => {
        const id = nextScopedHandlerIdRef.current;
        nextScopedHandlerIdRef.current += 1;
        setScopedHandlerEntries((current) => {
            const next = new Map(current);
            next.set(id, { handlers, nativeInput, context });
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
    // The commands whose effective (latest) registration owns its keys; a later ordinary registrant takes them back.
    const ownedCommandIdsKey = React.useMemo(() => {
        const owned = new Set<KeyboardCommandId>();
        for (const entry of scopedHandlerEntries.values()) {
            for (const id of Object.keys(entry.handlers) as KeyboardCommandId[]) {
                if (entry.context?.ownsKeys === true) owned.add(id);
                else owned.delete(id);
            }
        }
        return [...owned].sort().join(HANDLER_KEY_SIGNATURE_SEPARATOR);
    }, [scopedHandlerEntries]);
    const ownedCommandIds = React.useMemo<readonly KeyboardCommandId[]>(
        () => (ownedCommandIdsKey ? ownedCommandIdsKey.split(HANDLER_KEY_SIGNATURE_SEPARATOR) as KeyboardCommandId[] : NO_OWNED_COMMAND_IDS),
        [ownedCommandIdsKey]);
    const nativeInputs = React.useMemo(() => [...scopedHandlerEntries.values()]
        .flatMap((entry) => entry.nativeInput ? [entry.nativeInput] : []).reverse(), [scopedHandlerEntries]);
    const nativeInputsRef = React.useRef(nativeInputs);
    nativeInputsRef.current = nativeInputs;
    const composerInputFocused = [...scopedHandlerEntries.values()].some(entry => entry.context?.isComposerTarget === true);
    const propHandlers = props.handlers;
    const platform = React.useMemo(resolveKeyboardPlatform, []);
    const surface: KeyboardSurface = Platform.OS === 'web' ? 'web' : 'native';
    const webHost = isDesktopHost() ? 'desktop' as const : 'browser' as const;
    const {
        keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutOverridesV1,
        keyboardShortcutDisabledCommandIdsV1,
    } = useSettingsValues([
        'keyboardSingleKeyShortcutsEnabled',
        'keyboardShortcutOverridesV1', 'keyboardShortcutDisabledCommandIdsV1',
    ]);
    const singleKeyShortcutsEnabled = keyboardSingleKeyShortcutsEnabled === true;
    const disabledCommandIds = keyboardShortcutDisabledCommandIdsV1 ?? NO_DISABLED_COMMAND_IDS;
    const overrides = keyboardShortcutOverridesV1 ?? NO_SHORTCUT_OVERRIDES;
    const defaultLabelContext = React.useMemo(() => ({
        isEditableTarget: false,
        // Hints describe the registered composer's command; event dispatch checks actual focus.
        isComposerTarget: true,
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
    // One retained value feeds both the store and the context: a recompute with the same content
    // (handler registrations changing, a fresh `handlers` prop) must not re-render every label consumer.
    const retainedLabelsRef = React.useRef<KeyboardShortcutLabels | undefined>(undefined);
    const retainedLabels = retainIfEqual(retainedLabelsRef.current, shortcutLabels);
    retainedLabelsRef.current = retainedLabels;
    React.useLayoutEffect(() => { labels.setState(retainIfEqual(labels.getState(), retainedLabels), true); }, [labels, retainedLabels]);

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
        ownedCommandIdsKey,
        platform,
        surface,
        singleKeyShortcutsEnabled === true ? 'single-key-on' : 'single-key-off',
        buildSignatureListKey(disabledCommandIds),
        buildKeyboardShortcutOverridesSignature(overrides),
        handlerKeySignature,
    ].join(HANDLER_KEY_SIGNATURE_SEPARATOR), [
        disabledCommandIds,
        handlerKeySignature,
        overrides,
        platform,
        ownedCommandIdsKey,
        singleKeyShortcutsEnabled,
        surface,
    ]);
    const dispatcherOptions = React.useMemo(() => ({
        ownedCommandIds,
        platform,
        surface,
        webHost,
        singleKeyShortcutsEnabled,
        disabledCommandIds,
        overrides,
        handlers,
        getContext: () => ({
            isEditableTarget: false,
            isComposerTarget: composerInputFocused,
            isComposing: false,
            findInputFocused: find.resolve()?.isInputFocused() === true,
        }),
    }), [
        disabledCommandIds,
        find,
        handlers,
        overrides,
        platform,
        ownedCommandIds,
        singleKeyShortcutsEnabled,
        surface,
        webHost,
        composerInputFocused,
    ]);
    const dispatcherOptionsRef = React.useRef(dispatcherOptions);
    dispatcherOptionsRef.current = dispatcherOptions;
    const composerTypeToFocusEnabledRef = React.useRef(true);
    composerTypeToFocusEnabledRef.current = useLocalSetting('composerTypeToFocusEnabled');
    const executeCommand = React.useCallback((commandId: KeyboardCommandId): boolean => {
        const handler = dispatcherOptionsRef.current.handlers[commandId];
        if (!handler) return false;
        return handler() !== 'pass';
    }, []);
    const isCommandAvailable = React.useCallback((commandId: KeyboardCommandId): boolean =>
        dispatcherOptionsRef.current.handlers[commandId] !== undefined, []);
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
        () => ({ labels, registerHandlers, executeCommand, isCommandAvailable, submitFindInput, find, refreshFindAvailability }),
        [labels, registerHandlers, executeCommand, isCommandAvailable, submitFindInput, find, refreshFindAvailability],
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
        const dispatchEvent = (event: KeyboardEvent, captureEmbedded: boolean) => {
            if (event.defaultPrevented === true) return;
            const currentOptions = dispatcherOptionsRef.current;
            const capturedHandlers = {
                ...selectEmbeddedKeyboardHandlers(currentOptions.handlers, 'editor'),
                ...selectEmbeddedKeyboardHandlers(currentOptions.handlers, 'browser'),
            };
            const hiddenReviewTarget = captureEmbedded && isKeyboardTargetHidden(event.target);
            if (hiddenReviewTarget) {
                for (const id of Object.keys(currentOptions.handlers) as KeyboardCommandId[]) {
                    if (id.startsWith('review.')) capturedHandlers[id] = currentOptions.handlers[id];
                }
            }
            const ordinaryHandlers = { ...currentOptions.handlers };
            for (const id of Object.keys(capturedHandlers) as KeyboardCommandId[]) delete ordinaryHandlers[id];
            const dispatcher = createKeyboardShortcutDispatcher({
                ...currentOptions,
                handlers: captureEmbedded ? capturedHandlers : ordinaryHandlers,
                getContext: () => ({
                    ...readKeyboardContextFromEventTarget(event.target),
                    ...(hiddenReviewTarget ? { isEditableTarget: false, isInteractiveTarget: false } : {}),
                    isComposing: event.isComposing === true,
                }),
            });
            const normalized = normalizeKeyboardEvent(event);
            if (!dispatcher(normalized)) {
                if (!captureEmbedded) focusComposerForTyping(event);
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (captureEmbedded) event.stopImmediatePropagation();
        };
        // Unhandled typing outside a text field moves into the current composer. Focus moves during
        // keydown and the default action stays, so the browser types this first character there.
        const focusComposerForTyping = (event: KeyboardEvent) => {
            if (!composerTypeToFocusEnabledRef.current) return;
            if (!isComposerTypeToFocusKey({
                key: event.key,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
                isComposing: event.isComposing,
                altGraph: event.getModifierState?.('AltGraph') === true,
            })) return;
            if (readKeyboardContextFromEventTarget(event.target).isEditableTarget) return;
            // Modals trap focus inside their dialog; popovers, menus and Find register on the escape stack.
            if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"], [aria-modal="true"]')) return;
            if (getMaxEscapeKeyBlockerPriority() > ESCAPE_LAYER_PRIORITIES.overlay) return;
            executeCommand('composer.focus');
        };
        // Streamed pages and editors consume their own keydown events before the bubble listener.
        const captureEmbedded = (event: KeyboardEvent) => dispatchEvent(event, true);
        const handleKeyDown = (event: KeyboardEvent) => dispatchEvent(event, false);
        const recordInteraction = (event: Event) => {
            find.recordInteraction(event.target);
            refreshFindAvailability();
        };
        window.addEventListener('keydown', captureEmbedded, true);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('pointerdown', recordInteraction, true);
        // Native click focus may move to a pane ancestor outside the registered
        // viewport. The completed click still belongs to its original surface.
        window.addEventListener('click', recordInteraction, true);
        window.addEventListener('focusin', recordInteraction);
        window.addEventListener('focusout', refreshFindAvailability);
        return () => {
            window.removeEventListener('keydown', captureEmbedded, true);
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('pointerdown', recordInteraction, true);
            window.removeEventListener('click', recordInteraction, true);
            window.removeEventListener('focusin', recordInteraction);
            window.removeEventListener('focusout', refreshFindAvailability);
        };
    }, [executeCommand, find]);

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
                    isComposerTarget: currentOptions.getContext().isComposerTarget === true && nativeEvent.isEditableTarget !== false,
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
            <KeyboardShortcutLabelsContext.Provider value={retainedLabels}>
                <FocusReturnProvider>{props.children}</FocusReturnProvider>
            </KeyboardShortcutLabelsContext.Provider>
            </EmbeddedKeyboardContext.Provider>
        </KeyboardShortcutRegistrationContext.Provider>
    );
}
