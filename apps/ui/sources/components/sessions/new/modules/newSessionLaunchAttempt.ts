import { randomUUID } from '@/platform/randomUUID';
import {
    normalizeSpawnAttemptKey,
    readOrCreateSpawnAttemptNonce,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

export type NewSessionLaunchAttemptStatus =
    | 'idle'
    | 'spawning'
    | 'created'
    | 'uploading_attachments'
    | 'sending_first_turn'
    | 'complete'
    | 'failed_retryable'
    | 'failed_fatal';

export type NewSessionLaunchAttemptFailurePhase =
    | 'spawning'
    | 'created'
    | 'uploading_attachments'
    | 'sending_first_turn';

export type NewSessionLaunchAttemptPhaseError = Readonly<{
    message: string;
    retryable: boolean;
}>;

export type NewSessionLaunchAttempt = Readonly<{
    attemptId: string;
    spawnNonce: string;
    spawnAttemptKey: string | null;
    scopeKey: string;
    createdSessionId: string | null;
    daemonInitialPromptUsed: boolean;
    firstTurnLocalId: string;
    attachmentMessageLocalId: string;
    status: NewSessionLaunchAttemptStatus;
    prompt: Readonly<{
        prompt: string;
        displayText: string;
        meta: unknown;
    }>;
    phaseErrors: Partial<Record<NewSessionLaunchAttemptFailurePhase, NewSessionLaunchAttemptPhaseError>>;
}>;

type CreateNewSessionLaunchAttemptParams = Readonly<{
    prompt: string;
    displayText: string;
    scopeKey: string;
    meta?: unknown;
    spawnAttemptKey?: string | null;
    createId?: (prefix: string) => string;
}>;

function defaultCreateId(prefix: string): string {
    const legacyPrefixByName: Record<string, string> = {
        attempt: 'new-session-attempt',
        spawn: 'new-session-spawn',
        'first-turn': 'new-session-first-turn',
        'attachment-message': 'new-session-attachment',
    };
    return `${legacyPrefixByName[prefix] ?? prefix}-${randomUUID()}`;
}

export function createNewSessionLaunchAttempt(params: CreateNewSessionLaunchAttemptParams): NewSessionLaunchAttempt {
    const createId = params.createId ?? defaultCreateId;
    const spawnAttemptKey = normalizeSpawnAttemptKey(params.spawnAttemptKey);
    return {
        attemptId: createId('attempt'),
        spawnNonce: readOrCreateSpawnAttemptNonce({
            spawnAttemptKey,
            seedNonce: createId('spawn'),
        }),
        spawnAttemptKey,
        scopeKey: params.scopeKey,
        firstTurnLocalId: createId('first-turn'),
        attachmentMessageLocalId: createId('attachment-message'),
        createdSessionId: null,
        daemonInitialPromptUsed: false,
        status: 'idle',
        prompt: {
            prompt: params.prompt,
            displayText: params.displayText,
            meta: params.meta ?? null,
        },
        phaseErrors: {},
    };
}

export function markNewSessionLaunchAttemptDaemonInitialPromptUsed(
    attempt: NewSessionLaunchAttempt,
): NewSessionLaunchAttempt {
    if (attempt.daemonInitialPromptUsed) return attempt;
    return {
        ...attempt,
        daemonInitialPromptUsed: true,
    };
}

export function markNewSessionLaunchAttemptCreated(
    attempt: NewSessionLaunchAttempt,
    params: Readonly<{ createdSessionId: string }>,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        createdSessionId: params.createdSessionId,
        status: 'created',
    };
}

export function markNewSessionLaunchAttemptSpawning(
    attempt: NewSessionLaunchAttempt,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        status: 'spawning',
    };
}

export function markNewSessionLaunchAttemptSendingFirstTurn(
    attempt: NewSessionLaunchAttempt,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        status: 'sending_first_turn',
    };
}

export function markNewSessionLaunchAttemptComplete(
    attempt: NewSessionLaunchAttempt,
): NewSessionLaunchAttempt {
    return {
        ...attempt,
        status: 'complete',
    };
}

export function markNewSessionLaunchAttemptFailed(
    attempt: NewSessionLaunchAttempt,
    params: Readonly<{
        phase: NewSessionLaunchAttemptFailurePhase;
        error: unknown;
        retryable: boolean;
    }>,
): NewSessionLaunchAttempt {
    const message = params.error instanceof Error ? params.error.message : String(params.error);
    return {
        ...attempt,
        status: params.retryable ? 'failed_retryable' : 'failed_fatal',
        phaseErrors: {
            ...attempt.phaseErrors,
            [params.phase]: {
                message,
                retryable: params.retryable,
            },
        },
    };
}

export function shouldSpawnForNewSessionLaunchAttempt(attempt: NewSessionLaunchAttempt): boolean {
    return !attempt.createdSessionId;
}

export function isNewSessionLaunchAttemptPendingBeforeSession(
    attempt: NewSessionLaunchAttempt | null | undefined,
): attempt is NewSessionLaunchAttempt {
    return !!attempt
        && attempt.createdSessionId === null
        && (attempt.status === 'idle' || attempt.status === 'spawning');
}

export function isNewSessionLaunchAttemptInScope(
    attempt: NewSessionLaunchAttempt | null,
    scopeKey: string,
    spawnAttemptKey: string | null,
): attempt is NewSessionLaunchAttempt {
    return !!attempt
        && attempt.scopeKey === scopeKey
        && attempt.spawnAttemptKey === normalizeSpawnAttemptKey(spawnAttemptKey);
}
