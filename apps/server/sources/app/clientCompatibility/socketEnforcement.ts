import {
    CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    parseClientCompatibilitySocketAuthV1,
    type ClientCompatibilityDeclarationParseResult,
    type ClientKind,
} from '@happier-dev/protocol';
import type { Socket } from 'socket.io';

import { evaluateSessionSyncCompatibility, type SessionSyncCompatibilityEvaluation } from './decision';
import { resolveSessionSyncCompatibilityPolicy } from './policy';

export interface SessionSyncSocketCompatibilityResult {
    readonly parseResult: ClientCompatibilityDeclarationParseResult;
    readonly evaluation: SessionSyncCompatibilityEvaluation;
}

export function readSessionSyncSocketCompatibility(
    socket: Pick<Socket, 'data'>,
): SessionSyncSocketCompatibilityResult | null {
    return socket.data.sessionSyncCompatibility ?? null;
}

export function writeSessionSyncSocketCompatibility(
    socket: Pick<Socket, 'data'>,
    compatibility: SessionSyncSocketCompatibilityResult,
): void {
    socket.data.sessionSyncCompatibility = compatibility;
}

export type SessionSyncCompatibilitySocketClientType = 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;

const USER_SCOPED_CLIENT_KINDS = Object.freeze([
    'ui-web',
    'ui-ios',
    'ui-android',
    'ui-desktop',
    'session-runner',
] satisfies readonly ClientKind[]);

function constraintsForSocketType(clientType: SessionSyncCompatibilitySocketClientType) {
    return {
        allowedClientKinds: clientType === 'session-scoped'
            ? ['session-runner'] as const
            : clientType === 'machine-scoped'
                ? ['daemon'] as const
                : USER_SCOPED_CLIENT_KINDS,
    };
}

export function evaluateSessionSyncSocketCompatibility(
    auth: unknown,
    env: NodeJS.ProcessEnv,
    clientType: SessionSyncCompatibilitySocketClientType = undefined,
): SessionSyncSocketCompatibilityResult {
    const parseResult = parseClientCompatibilitySocketAuthV1(auth);
    return {
        parseResult,
        evaluation: revalidateSessionSyncSocketCompatibility(parseResult, env, clientType),
    };
}

export function revalidateSessionSyncSocketCompatibility(
    parseResult: ClientCompatibilityDeclarationParseResult,
    env: NodeJS.ProcessEnv,
    clientType: SessionSyncCompatibilitySocketClientType = undefined,
): SessionSyncCompatibilityEvaluation {
    return evaluateSessionSyncCompatibility(
        parseResult,
        resolveSessionSyncCompatibilityPolicy(env),
        constraintsForSocketType(clientType),
    );
}

export function buildSessionSyncSocketUpgradeError(
    evaluation: SessionSyncCompatibilityEvaluation,
): Error & { data: unknown } {
    if (evaluation.upgradeRequired === null) {
        throw new Error('Cannot build an upgrade error for an accepted compatibility decision');
    }
    const error = new Error(CLIENT_UPGRADE_REQUIRED_ERROR_CODE) as Error & { data: unknown };
    error.data = evaluation.upgradeRequired;
    return error;
}
