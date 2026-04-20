type CodexAppServerThreadResponse = Readonly<{
    threadId?: unknown;
    id?: unknown;
    thread?: Readonly<{ id?: unknown; threadId?: unknown }> | null;
}>;

type CodexAppServerTurnResponse = Readonly<{
    turnId?: unknown;
    id?: unknown;
    turn?: Readonly<{ id?: unknown; turnId?: unknown }> | null;
}>;

export function readRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export function trimSessionId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function trimStringValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function readThreadId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as CodexAppServerThreadResponse;
    const candidates = [response.threadId, response.id, response.thread?.threadId, response.thread?.id];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}

export function readTurnId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as CodexAppServerTurnResponse;
    const candidates = [response.turnId, response.id, response.turn?.turnId, response.turn?.id];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}

export function readRollbackUnsupportedErrorMessage(error: unknown): string | null {
    if (!(error instanceof Error)) return null;
    const message = error.message.trim();
    if (message.length === 0) return null;
    const normalized = message.toLowerCase();
    if (normalized.includes('method not found') || normalized.includes('invalid params')) {
        return message;
    }
    return null;
}

export function readModelId(value: unknown): string | null {
    const record = readRecord(value);
    return record ? trimStringValue(record.model) : null;
}

export function readServiceTier(value: unknown): string | null {
    const record = readRecord(value);
    return record ? trimStringValue(record.serviceTier) ?? trimStringValue(record.service_tier) : null;
}

export function readCodexTurnStatus(value: unknown): string | null {
    const record = readRecord(value);
    const turn = readRecord(record?.turn);
    return trimStringValue(turn?.status);
}

export function readCodexAppServerErrorMessage(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) return null;

    const directError = readRecord(record.error);
    const turn = readRecord(record.turn);
    const turnError = readRecord(turn?.error);
    const error = directError ?? turnError;
    if (!error) return null;

    const message = trimStringValue(error.message);
    const additionalDetails = trimStringValue(error.additionalDetails ?? error.additional_details);
    if (message && additionalDetails) {
        return `${message}\n\n${additionalDetails}`;
    }
    return message ?? additionalDetails;
}

export function createCodexAppServerTurnFailure(value: unknown): Error {
    return new Error(readCodexAppServerErrorMessage(value) ?? 'Codex app-server turn failed');
}

export function formatCodexAppServerErrorForUi(error: Error): string {
    const message = error.message.trim();
    if (!message) return 'Codex error';
    return /^error[:\s]/i.test(message) ? message : `Error: ${message}`;
}

export function buildThreadServiceTierParams(
    currentServiceTier: string | null,
    hasServiceTierOverride: boolean,
): { serviceTier?: 'fast' | null } {
    if (!hasServiceTierOverride) {
        return {};
    }
    return currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null };
}
