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

const CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE =
    'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';

type CodexAppServerErrorPayload = Readonly<{
    message: string | null;
    additionalDetails: string | null;
    codexErrorInfo: string | null;
}>;

class CodexAppServerTurnFailure extends Error {
    readonly isAuthAccountChanged: boolean;

    constructor(message: string, options: Readonly<{ isAuthAccountChanged: boolean }>) {
        super(message);
        this.name = 'CodexAppServerTurnFailure';
        this.isAuthAccountChanged = options.isAuthAccountChanged;
    }
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

function readCodexAppServerErrorPayload(value: unknown): CodexAppServerErrorPayload | null {
    const record = readRecord(value);
    if (!record) return null;

    const directError = readRecord(record.error);
    const turn = readRecord(record.turn);
    const turnError = readRecord(turn?.error);
    const error = directError ?? turnError;
    if (!error) return null;

    return {
        message: trimStringValue(error.message),
        additionalDetails: trimStringValue(error.additionalDetails ?? error.additional_details),
        codexErrorInfo: trimStringValue(error.codexErrorInfo ?? error.codex_error_info),
    };
}

function formatCodexAppServerErrorPayloadMessage(payload: CodexAppServerErrorPayload): string | null {
    if (payload.message && payload.additionalDetails) {
        return `${payload.message}\n\n${payload.additionalDetails}`;
    }
    return payload.message ?? payload.additionalDetails;
}

export function readCodexAppServerErrorMessage(value: unknown): string | null {
    const payload = readCodexAppServerErrorPayload(value);
    return payload ? formatCodexAppServerErrorPayloadMessage(payload) : null;
}

function isCodexAppServerAuthAccountChangedPayload(payload: CodexAppServerErrorPayload): boolean {
    const codexErrorInfo = payload.codexErrorInfo?.toLowerCase() ?? null;
    const hasAuthAccountChangedMessage = [payload.message, payload.additionalDetails].some((value) =>
        value?.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE),
    );
    return hasAuthAccountChangedMessage && (!codexErrorInfo || codexErrorInfo === 'unauthorized');
}

export function isCodexAppServerAuthAccountChangedError(error: unknown): boolean {
    if (error instanceof CodexAppServerTurnFailure) {
        return error.isAuthAccountChanged;
    }
    if (!(error instanceof Error)) return false;
    return error.message.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE);
}

export function createCodexAppServerTurnFailure(value: unknown): Error {
    const payload = readCodexAppServerErrorPayload(value);
    return new CodexAppServerTurnFailure(
        payload ? formatCodexAppServerErrorPayloadMessage(payload) ?? 'Codex app-server turn failed' : 'Codex app-server turn failed',
        { isAuthAccountChanged: payload ? isCodexAppServerAuthAccountChangedPayload(payload) : false },
    );
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
