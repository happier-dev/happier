import {
    normalizeCodexBackendMode as normalizeCanonicalCodexBackendMode,
    resolveMetadataStringOverrideV1,
    type CodexBackendMode,
} from '@happier-dev/agents';
import {
    SessionAuthoringTerminalV1Schema,
    SessionAuthoringValueV1Schema,
    type SessionAuthoringTerminalV1,
    type SessionAuthoringValueV1,
} from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';

export const normalizeCodexBackendMode = normalizeCanonicalCodexBackendMode;

export function normalizeRequiredString(value: string): string {
    return value.trim();
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function normalizeOptionalNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function resolveCanonicalCodexBackendMode(params: Readonly<{
    codexBackendMode?: unknown;
    experimentalCodexAcp?: unknown;
}>): CodexBackendMode | null {
    const codexBackendMode = normalizeCodexBackendMode(params.codexBackendMode);
    if (codexBackendMode) {
        return codexBackendMode;
    }
    return params.experimentalCodexAcp === true ? 'acp' : null;
}

export function normalizeOptionalRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

export function normalizeTranscriptStorage(value: unknown): 'direct' | 'persisted' | null {
    return value === 'direct' || value === 'persisted' ? value : null;
}

export function normalizeSessionAuthoringConnectedServices(
    value: unknown,
): SessionAuthoringValueV1['connectedServices'] {
    const parsed = SessionAuthoringValueV1Schema.shape.connectedServices.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function normalizeSessionAuthoringTerminal(
    value: unknown,
): SessionAuthoringTerminalV1 | null {
    const parsed = SessionAuthoringTerminalV1Schema.nullable().safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function normalizeTerminalFromSessionMetadata(session: Pick<Session, 'metadata'>): SessionAuthoringTerminalV1 | null {
    const terminal = normalizeOptionalRecord(session.metadata?.terminal);
    if (!terminal) {
        return null;
    }
    const mode = terminal.mode;
    if (mode !== 'plain' && mode !== 'tmux' && mode !== 'windows_terminal' && mode !== 'windows_console') {
        return null;
    }
    const tmux = normalizeOptionalRecord(terminal.tmux);
    return {
        mode,
        ...(mode === 'tmux'
            ? {
                tmux: {
                    ...(typeof tmux?.target === 'string' && tmux.target.trim().length > 0
                        ? { sessionName: tmux.target.trim() }
                        : {}),
                    ...(typeof tmux?.tmpDir === 'string' || tmux?.tmpDir === null
                        ? { tmpDir: tmux.tmpDir }
                        : {}),
                },
            }
            : {}),
    };
}

export function resolveMetadataModelOverride(session: Pick<Session, 'metadata'>): Readonly<{
    modelId: string | null;
    modelUpdatedAt: number | null;
}> {
    const override = resolveMetadataStringOverrideV1(session.metadata as Record<string, unknown> | null, 'modelOverrideV1', 'modelId');
    return {
        modelId: normalizeOptionalString(override?.value),
        modelUpdatedAt: normalizeOptionalNumber(override?.updatedAt),
    };
}
