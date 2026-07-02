import * as React from 'react';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { FocusReturnProvider } from './focusReturn';
import {
    buildKeyboardShortcutLabels,
    createKeyboardShortcutDispatcher,
    hasAnyAvailableKeyboardHandler,
    normalizeKeyboardEvent,
    normalizeNativeHardwareKeyboardEvent,
    readKeyboardContextFromEventTarget,
    resolveNativeHardwareKeyboardConsumableEventSignatures,
    resolveKeyboardPlatform,
    type KeyboardShortcutHandlers,
    type NativeHardwareKeyboardEventLike,
} from './runtime';
import type { KeyboardCommandId, KeyboardSurface, KeybindingRule } from './types';
import * as nativeKeyboardBridge from '@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter';

type NativeKeyboardBridgeModule = typeof nativeKeyboardBridge & Readonly<{
    subscribeToNativeHardwareKeyboardEvents?: (
        listener: (event: NativeHardwareKeyboardEventLike) => void,
    ) => { remove(): void } | null;
}>;

type KeyboardShortcutRegistrationContextValue = Readonly<{
    registerHandlers: (handlers: KeyboardShortcutHandlers) => () => void;
}>;

const KeyboardShortcutRegistrationContext = React.createContext<KeyboardShortcutRegistrationContextValue | null>(null);
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
            next[key] = () => {
                latestHandlersRef.current[key]?.();
            };
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

function buildHelpBody(shortcutLabels: Partial<Record<string, string>>): string {
    const lines = [
        shortcutLabels['commandPalette.open']
            ? `${t('commandPalette.shortcutsHelpCommandPalette')}: ${shortcutLabels['commandPalette.open']}`
            : null,
        shortcutLabels['shortcutsHelp.open']
            ? `${t('commandPalette.shortcutsHelpHelp')}: ${shortcutLabels['shortcutsHelp.open']}`
            : null,
        shortcutLabels['session.new']
            ? `${t('commandPalette.shortcutsHelpNewSession')}: ${shortcutLabels['session.new']}`
            : null,
    ].filter((line): line is string => Boolean(line));
    if (lines.length === 0) return t('commandPalette.shortcutsHelpEmpty');
    return t('commandPalette.shortcutsHelpBody', { shortcuts: lines.join('\n') });
}

export function KeyboardShortcutProvider(props: React.PropsWithChildren<Readonly<{
    handlers: KeyboardShortcutHandlers;
    enabledWhenDisabledCommandIds?: readonly KeyboardCommandId[];
}>>) {
    const nextScopedHandlerIdRef = React.useRef(1);
    const [scopedHandlerEntries, setScopedHandlerEntries] = React.useState<ReadonlyMap<number, KeyboardShortcutHandlers>>(
        () => new Map(),
    );
    const registerHandlers = React.useCallback((handlers: KeyboardShortcutHandlers) => {
        const id = nextScopedHandlerIdRef.current;
        nextScopedHandlerIdRef.current += 1;
        setScopedHandlerEntries((current) => {
            const next = new Map(current);
            next.set(id, handlers);
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
    const registrationContextValue = React.useMemo<KeyboardShortcutRegistrationContextValue>(
        () => ({ registerHandlers }),
        [registerHandlers],
    );
    const scopedHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        const next: KeyboardShortcutHandlers = {};
        for (const handlers of scopedHandlerEntries.values()) {
            Object.assign(next, handlers);
        }
        return next;
    }, [scopedHandlerEntries]);
    const propHandlers = props.handlers;
    const platform = React.useMemo(resolveKeyboardPlatform, []);
    const surface: KeyboardSurface = Platform.OS === 'web' ? 'web' : 'native';
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
    const disabledCommandIds = keyboardShortcutDisabledCommandIdsV1 ?? [];
    const overrides = keyboardShortcutOverridesV1 ?? {};
    const defaultLabelContext = React.useMemo(() => ({
        isEditableTarget: false,
        isComposing: false,
    }), []);
    const rootHandlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...propHandlers,
        ...scopedHandlers,
    }), [propHandlers, scopedHandlers]);
    const labelHandlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...rootHandlers,
        'shortcutsHelp.open': () => undefined,
    }), [rootHandlers]);

    const shortcutLabels = React.useMemo(
        () => buildKeyboardShortcutLabels(platform, surface, {
            disabledCommandIds,
            overrides,
            singleKeyShortcutsEnabled,
            handlers: labelHandlers,
            context: defaultLabelContext,
        }),
        [defaultLabelContext, disabledCommandIds, labelHandlers, overrides, platform, singleKeyShortcutsEnabled, surface],
    );

    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...rootHandlers,
        'shortcutsHelp.open': () => {
            void Modal.alertAsync(t('commandPalette.shortcutsHelpTitle'), buildHelpBody(shortcutLabels));
        },
    }), [rootHandlers, shortcutLabels]);
    const handlerKeySignature = buildHandlerKeySignature(handlers);
    const nativeKeyboardConfigurationKey = React.useMemo(() => [
        keyboardShortcutsV2Enabled === true ? 'enabled' : 'disabled',
        buildSignatureListKey(props.enabledWhenDisabledCommandIds ?? []),
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
        props.enabledWhenDisabledCommandIds,
        singleKeyShortcutsEnabled,
        surface,
    ]);
    const dispatcherOptions = React.useMemo(() => ({
        enabled: keyboardShortcutsV2Enabled === true,
        enabledWhenDisabledCommandIds: props.enabledWhenDisabledCommandIds,
        platform,
        surface,
        singleKeyShortcutsEnabled,
        disabledCommandIds,
        overrides,
        handlers,
        getContext: () => ({
            isEditableTarget: false,
            isComposing: false,
        }),
    }), [
        disabledCommandIds,
        handlers,
        keyboardShortcutsV2Enabled,
        overrides,
        platform,
        props.enabledWhenDisabledCommandIds,
        singleKeyShortcutsEnabled,
        surface,
    ]);
    const dispatcherOptionsRef = React.useRef(dispatcherOptions);
    dispatcherOptionsRef.current = dispatcherOptions;
    const nativeHardwareKeyboardRegistration = React.useMemo(() => {
        const hasAvailableHandler = hasAnyAvailableKeyboardHandler(dispatcherOptions);
        const consumableEventSignatures = hasAvailableHandler
            ? resolveNativeHardwareKeyboardConsumableEventSignatures(dispatcherOptions)
            : [];
        return {
            consumableEventSignatures,
            key: hasAvailableHandler
                ? [
                    nativeKeyboardConfigurationKey,
                    buildSignatureListKey(consumableEventSignatures),
                ].join(HANDLER_KEY_SIGNATURE_SEPARATOR)
                : '',
        };
    }, [dispatcherOptions, nativeKeyboardConfigurationKey]);
    const nativeHardwareKeyboardRegistrationRef = React.useRef(nativeHardwareKeyboardRegistration);
    nativeHardwareKeyboardRegistrationRef.current = nativeHardwareKeyboardRegistration;

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented === true) return;
            const currentOptions = dispatcherOptionsRef.current;
            const dispatcher = createKeyboardShortcutDispatcher({
                ...currentOptions,
                getContext: () => ({
                    ...readKeyboardContextFromEventTarget(event.target),
                    isComposing: event.isComposing === true,
                }),
            });
            if (!dispatcher(normalizeKeyboardEvent(event))) return;
            event.preventDefault();
            event.stopPropagation();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

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
            const currentOptions = dispatcherOptionsRef.current;
            const dispatcher = createKeyboardShortcutDispatcher({
                ...currentOptions,
                getContext: () => ({
                    isEditableTarget: false,
                    isComposing: event.isComposing,
                }),
            });
            dispatcher(event);
        });

        return () => {
            subscription?.remove();
            bridge.configureNativeHardwareKeyboardConsumableEventSignatures?.([]);
        };
    }, [nativeHardwareKeyboardRegistration.key]);

    return (
        <KeyboardShortcutRegistrationContext.Provider value={registrationContextValue}>
            <FocusReturnProvider>{props.children}</FocusReturnProvider>
        </KeyboardShortcutRegistrationContext.Provider>
    );
}
