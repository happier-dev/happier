import * as React from 'react';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
    buildKeyboardShortcutLabels,
    buildNativeHardwareKeyboardAllowlist,
    createKeyboardShortcutDispatcher,
    normalizeKeyboardEvent,
    normalizeNativeHardwareKeyboardEvent,
    readKeyboardContextFromEventTarget,
    resolveKeyboardPlatform,
    type NativeHardwareKeyboardAllowlist,
    type KeyboardShortcutHandlers,
} from './runtime';
import type { KeyboardCommandId, KeybindingRule } from './types';
import { FocusReturnProvider } from './focusReturn';
import { subscribeToNativeHardwareKeyboardEvents } from '@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter';

type KeyboardShortcutRegistrationContextValue = Readonly<{
    registerHandlers: (handlers: KeyboardShortcutHandlers) => () => void;
    executeCommand: (commandId: KeyboardCommandId) => boolean;
}>;

const KeyboardShortcutRegistrationContext = React.createContext<KeyboardShortcutRegistrationContextValue | null>(null);
const HANDLER_KEY_SIGNATURE_SEPARATOR = '\u0000';

function buildHandlerKeySignature(handlers: KeyboardShortcutHandlers): string {
    return Object.keys(handlers).sort().join(HANDLER_KEY_SIGNATURE_SEPARATOR);
}

function buildNativeHardwareAllowlistSignature(allowlist: NativeHardwareKeyboardAllowlist | null): string {
    if (!allowlist) return '';
    return allowlist.allowedEvents
        .map((event) => [
            event.key,
            event.modifiers.shift ? 'shift' : '',
            event.modifiers.ctrl ? 'ctrl' : '',
            event.modifiers.meta ? 'meta' : '',
            event.modifiers.alt ? 'alt' : '',
        ].join(HANDLER_KEY_SIGNATURE_SEPARATOR))
        .sort()
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

/** Explicit UI actions share command handlers without depending on keyboard binding preferences. */
export function useKeyboardCommand(): (commandId: KeyboardCommandId) => boolean {
    const registration = React.useContext(KeyboardShortcutRegistrationContext);
    return React.useCallback((commandId: KeyboardCommandId) => registration?.executeCommand(commandId) ?? false, [registration]);
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
    const scopedHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        const next: KeyboardShortcutHandlers = {};
        for (const handlers of scopedHandlerEntries.values()) {
            Object.assign(next, handlers);
        }
        return next;
    }, [scopedHandlerEntries]);
    const rootHandlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...props.handlers,
        ...scopedHandlers,
    }), [props.handlers, scopedHandlers]);
    const platform = React.useMemo(resolveKeyboardPlatform, []);
    const surface = Platform.OS === 'web' ? 'web' : 'native';
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
    const labelHandlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...rootHandlers,
        'shortcutsHelp.open': () => undefined,
    }), [rootHandlers]);

    const shortcutLabels = React.useMemo(
        () => buildKeyboardShortcutLabels(platform, surface, {
            disabledCommandIds: keyboardShortcutDisabledCommandIdsV1 ?? [],
            overrides: keyboardShortcutOverridesV1 ?? {},
            singleKeyShortcutsEnabled: keyboardSingleKeyShortcutsEnabled === true,
            handlers: labelHandlers,
            context: {
                isEditableTarget: false,
                isComposing: false,
            },
        }),
        [
            keyboardShortcutDisabledCommandIdsV1,
            keyboardShortcutOverridesV1,
            keyboardSingleKeyShortcutsEnabled,
            labelHandlers,
            platform,
            surface,
        ],
    );

    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => ({
        ...rootHandlers,
        'shortcutsHelp.open': () => {
            void Modal.alertAsync(t('commandPalette.shortcutsHelpTitle'), buildHelpBody(shortcutLabels));
        },
    }), [rootHandlers, shortcutLabels]);
    const latestShortcutRuntimeRef = React.useRef<Readonly<{
        keyboardShortcutsV2Enabled: boolean | undefined;
        enabledWhenDisabledCommandIds: readonly KeyboardCommandId[] | undefined;
        keyboardSingleKeyShortcutsEnabled: boolean | undefined;
        keyboardShortcutDisabledCommandIdsV1: readonly string[] | undefined;
        keyboardShortcutOverridesV1: Readonly<Record<string, readonly KeybindingRule[]>> | undefined;
        handlers: KeyboardShortcutHandlers;
    }> | null>(null);
    latestShortcutRuntimeRef.current = {
        keyboardShortcutsV2Enabled,
        enabledWhenDisabledCommandIds: props.enabledWhenDisabledCommandIds,
        keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutDisabledCommandIdsV1,
        keyboardShortcutOverridesV1,
        handlers,
    };
    const executeCommand = React.useCallback((commandId: KeyboardCommandId): boolean => {
        const handler = latestShortcutRuntimeRef.current?.handlers[commandId];
        if (!handler) return false;
        handler();
        return true;
    }, []);
    const registrationContextValue = React.useMemo<KeyboardShortcutRegistrationContextValue>(
        () => ({ registerHandlers, executeCommand }),
        [registerHandlers, executeCommand],
    );
    const nativeHardwareAllowlist = React.useMemo(
        () => buildNativeHardwareKeyboardAllowlist({
            enabled: keyboardShortcutsV2Enabled === true,
            platform,
            surface,
            singleKeyShortcutsEnabled: keyboardSingleKeyShortcutsEnabled === true,
            disabledCommandIds: keyboardShortcutDisabledCommandIdsV1 ?? [],
            overrides: keyboardShortcutOverridesV1 ?? {},
            handlers,
            getContext: () => ({
                isEditableTarget: false,
                isComposing: false,
            }),
        }),
        [
            handlers,
            keyboardShortcutDisabledCommandIdsV1,
            keyboardShortcutOverridesV1,
            keyboardShortcutsV2Enabled,
            keyboardSingleKeyShortcutsEnabled,
            platform,
            surface,
        ],
    );
    const nativeHardwareAllowlistRef = React.useRef<NativeHardwareKeyboardAllowlist | null>(nativeHardwareAllowlist);
    nativeHardwareAllowlistRef.current = nativeHardwareAllowlist;
    const nativeHardwareAllowlistSignature = React.useMemo(
        () => buildNativeHardwareAllowlistSignature(nativeHardwareAllowlist),
        [nativeHardwareAllowlist],
    );

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented === true) return;
            const latestShortcutRuntime = latestShortcutRuntimeRef.current;
            if (!latestShortcutRuntime) return;
            const dispatcher = createKeyboardShortcutDispatcher({
                enabled: latestShortcutRuntime.keyboardShortcutsV2Enabled === true,
                enabledWhenDisabledCommandIds: latestShortcutRuntime.enabledWhenDisabledCommandIds,
                platform,
                surface,
                singleKeyShortcutsEnabled: latestShortcutRuntime.keyboardSingleKeyShortcutsEnabled === true,
                disabledCommandIds: latestShortcutRuntime.keyboardShortcutDisabledCommandIdsV1 ?? [],
                overrides: latestShortcutRuntime.keyboardShortcutOverridesV1 ?? {},
                handlers: latestShortcutRuntime.handlers,
                getContext: () => ({
                    ...readKeyboardContextFromEventTarget(event.target),
                    isComposing: event.isComposing === true,
                }),
            });
            if (dispatcher(normalizeKeyboardEvent(event))) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            // Focus during keydown and leave its default action intact: the browser
            // inserts the first character into the newly focused composer as well.
            if (typeof navigator === 'undefined' || !/Win/i.test(navigator.platform)) return;
            if (event.isComposing || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
            if (readKeyboardContextFromEventTarget(event.target).isEditableTarget) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest?.('[role="menu"], [role="listbox"], [role="combobox"], [role="dialog"], dialog')) return;
            if (event.key === ' ' && target?.closest?.('button, a, [role="button"]')) return;
            if (typeof document !== 'undefined' && document.querySelector(
                '[role="dialog"], dialog[open], [aria-modal="true"], [role="menu"], [role="listbox"]',
            )) return;
            latestShortcutRuntime.handlers['composer.focus']?.();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [platform, surface]);

    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        const allowlist = nativeHardwareAllowlistRef.current;
        if (!allowlist) return;

        const subscription = subscribeToNativeHardwareKeyboardEvents((nativeEvent) => {
            const event = normalizeNativeHardwareKeyboardEvent(nativeEvent);
            const latestShortcutRuntime = latestShortcutRuntimeRef.current;
            if (!latestShortcutRuntime) return;
            const dispatcher = createKeyboardShortcutDispatcher({
                enabled: latestShortcutRuntime.keyboardShortcutsV2Enabled === true,
                enabledWhenDisabledCommandIds: latestShortcutRuntime.enabledWhenDisabledCommandIds,
                platform,
                surface,
                singleKeyShortcutsEnabled: latestShortcutRuntime.keyboardSingleKeyShortcutsEnabled === true,
                disabledCommandIds: latestShortcutRuntime.keyboardShortcutDisabledCommandIdsV1 ?? [],
                overrides: latestShortcutRuntime.keyboardShortcutOverridesV1 ?? {},
                handlers: latestShortcutRuntime.handlers,
                getContext: () => ({
                    isEditableTarget: false,
                    isComposing: event.isComposing,
                }),
            });
            dispatcher(event);
        }, allowlist);

        return () => {
            subscription?.remove();
        };
    }, [
        nativeHardwareAllowlistSignature,
        platform,
        surface,
    ]);

    return (
        <KeyboardShortcutRegistrationContext.Provider value={registrationContextValue}>
            <FocusReturnProvider>{props.children}</FocusReturnProvider>
        </KeyboardShortcutRegistrationContext.Provider>
    );
}
