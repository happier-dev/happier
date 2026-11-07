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
        // Keep a persisted null after clearing so a retained legacy source cannot replay.
        terminalNativeRendererQuarantineState.set('native', value);
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[terminal] Native renderer quarantine could not be persisted.');
    }
}

/** Import the former device Settings carrier before the preference parser drops it. */
export function migrateTerminalNativeRendererQuarantineFromSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
    if (!Object.hasOwn(settings, 'terminalNativeRendererQuarantine')) return settings;
    const record = settings as Record<string, unknown>;
    const parsed = NativeRendererQuarantineSchema.safeParse(record.terminalNativeRendererQuarantine);
    // Preserve an unreadable source through unrelated preference saves.
    if (!parsed.success) return settings;
    if (terminalNativeRendererQuarantineState.readStrict('native', value => NativeRendererQuarantineSchema.parse(value)) === undefined) {
        terminalNativeRendererQuarantineState.set('native', parsed.data);
    }
    const { terminalNativeRendererQuarantine: _legacyQuarantine, ...retained } = record;
    return retained;
}
