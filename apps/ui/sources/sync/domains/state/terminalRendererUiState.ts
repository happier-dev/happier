import { z } from 'zod/mini';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

const NativeRendererQuarantineSchema = z.nullable(z.object({
    renderer: z.enum(['ios-ghosttykit', 'android-termux']),
    expiresAtMs: z.number().check(z.positive()),
}));
export type NativeRendererQuarantine = z.infer<typeof NativeRendererQuarantineSchema>;

// Attributed renderer failures are device observations, independent of preferences.
export const terminalNativeRendererQuarantineState = createPersistentUiState<NativeRendererQuarantine>(
    'terminal-renderer-quarantine-v1',
    value => z.catch(NativeRendererQuarantineSchema, null).parse(value),
);

export function useTerminalNativeRendererQuarantine(): NativeRendererQuarantine {
    return usePersistentUiStateValue(terminalNativeRendererQuarantineState, 'native') ?? null;
}

export function writeTerminalNativeRendererQuarantine(value: NativeRendererQuarantine): void {
    try {
        terminalNativeRendererQuarantineState.set('native', value);
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[terminal] Native renderer quarantine could not be persisted.');
    }
}
