import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type {
    CurrentUiContextVoiceToolPort,
    CurrentUiContextVoiceCommandInvocationInput,
    CurrentUiContextVoiceActionInvocationInput,
    CurrentUiContextVoiceInvocationOutcome,
} from './currentUiContextVoiceToolPort';

export function unavailable(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'unavailable' };
}

/**
 * Narrows a stable current-UI port to one already-admitted Voice lifetime.
 * The AppShell port intentionally follows current refs while the attempt is
 * live; a capture that retires must instead stop reading or affecting a later
 * Account/client render. This wrapper adds no snapshot/cache or effect owner:
 * it only propagates that exact admission's existing cancellation signal into
 * the canonical reader and invocation boundaries.
 */
export function bindCurrentUiContextVoiceToolPortToAdmission(
    port: CurrentUiContextVoiceToolPort,
    admissionRetirementSignal: AbortSignal,
): CurrentUiContextVoiceToolPort {
    const isCurrent = (): boolean => !admissionRetirementSignal.aborted;
    const sourceInvokeCurrentUiCommand = port.invokeCurrentUiCommand;
    const invokeCurrentUiCommand = sourceInvokeCurrentUiCommand
        ? async (
            request: CurrentUiContextVoiceCommandInvocationInput,
        ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
            if (!isCurrent()) return unavailable();
            const merged = mergeAbortSignals([admissionRetirementSignal, request.signal]);
            try {
                if (merged.signal.aborted) return unavailable();
                // The wrapped AppShell port remains the sole effect/currentness
                // owner. In particular, preserve a result it has already
                // settled even if this admission retires before the await ends.
                return await sourceInvokeCurrentUiCommand({ ...request, signal: merged.signal });
            } finally {
                merged.dispose();
            }
        }
        : undefined;
    const sourceInvokeAction = port.invokeAction;
    const invokeAction = sourceInvokeAction
        ? async (
            request: CurrentUiContextVoiceActionInvocationInput,
        ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
            if (!isCurrent()) return unavailable();
            const merged = mergeAbortSignals([admissionRetirementSignal, request.signal]);
            try {
                if (merged.signal.aborted) return unavailable();
                return await sourceInvokeAction({ ...request, signal: merged.signal });
            } finally {
                merged.dispose();
            }
        }
        : undefined;

    return Object.freeze({
        ...port,
        readCurrentUiContext: () => isCurrent() ? port.readCurrentUiContext() : null,
        ...(port.readCurrentSessionId ? {
            readCurrentSessionId: () => isCurrent() ? port.readCurrentSessionId!() : null,
        } : {}),
        resolveCurrentUiCommand: (commandId) => isCurrent()
            ? port.resolveCurrentUiCommand(commandId)
            : null,
        subscribe: (listener) => {
            if (!isCurrent()) return () => {};
            let unsubscribed = false;
            let unsubscribe = () => {};
            const release = () => {
                if (unsubscribed) return;
                unsubscribed = true;
                admissionRetirementSignal.removeEventListener('abort', release);
                unsubscribe();
            };
            unsubscribe = port.subscribe(() => {
                if (isCurrent()) listener();
            });
            admissionRetirementSignal.addEventListener('abort', release, { once: true });
            if (!isCurrent()) release();
            return release;
        },
        ...(port.listCurrentContributedActionDefinitions
            ? {
                listCurrentContributedActionDefinitions: () => isCurrent()
                    ? port.listCurrentContributedActionDefinitions!()
                    : [],
            }
            : {}),
        ...(port.readCurrentContributedActionSchemas
            ? {
                readCurrentContributedActionSchemas: async (id: string, signal?: AbortSignal) => {
                    if (!isCurrent()) return null;
                    const schemas = await port.readCurrentContributedActionSchemas!(id, signal);
                    return isCurrent() ? schemas : null;
                },
            }
            : {}),
        ...(invokeCurrentUiCommand ? { invokeCurrentUiCommand } : {}),
        ...(invokeAction ? { invokeAction } : {}),
    });
}
