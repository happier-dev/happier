import {
    CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION,
    ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
    parseAccountStoredContentCompatibilityHttpHeadersV1,
    parseAccountStoredContentCompatibilitySocketAuthV1,
    type AccountStoredContentCompatibilityDeclarationParseResult,
    type AccountStoredContentCompatibilityDeclarationV1,
    type AccountStoredContentCompatibilityServerRequirementsV1,
    type AccountStoredContentUpgradeRequiredV1,
} from '@happier-dev/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Socket } from 'socket.io';

export const CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS:
    AccountStoredContentCompatibilityServerRequirementsV1 = Object.freeze({
        v: 1,
        // V3 adds the closed pluginDomain projection; V4 is an advertised
        // optional changes-page field. V2 remains sufficient for every
        // incumbent stored-content operation.
        minimumProtocolVersion: ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
        currentProtocolVersion:
            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
    });

export type AccountStoredContentCompatibilityOutcome =
    | 'accepted'
    | 'legacy-missing'
    | 'legacy-malformed'
    | 'legacy-protocol-too-old';

export interface AccountStoredContentCompatibilityEvaluation {
    readonly supportsCurrentProtocol: boolean;
    /** Whether this peer can receive the additive pluginDomain change kind. */
    readonly supportsPluginDataProtocol: boolean;
    /** Whether this peer can receive the additive Session-access witness. */
    readonly supportsSessionAccessWitnessProtocol: boolean;
    readonly outcome: AccountStoredContentCompatibilityOutcome;
    readonly declaration:
        AccountStoredContentCompatibilityDeclarationV1 | null;
    readonly upgradeRequired:
        AccountStoredContentUpgradeRequiredV1 | null;
}

export interface AccountStoredContentSocketCompatibilityResult {
    readonly parseResult:
        AccountStoredContentCompatibilityDeclarationParseResult;
    readonly evaluation: AccountStoredContentCompatibilityEvaluation;
}

export function buildAccountStoredContentUpgradeRequired():
    AccountStoredContentUpgradeRequiredV1 {
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            kind: 'account-stored-content',
            minimumProtocolVersion: ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
        },
    };
}

/**
 * Plugin collection data is the one V3-only stored-content operation. Keeping
 * this requirement beside the shared declaration owner avoids teaching every
 * consumer to reinterpret a V2 upgrade result as V3-capable.
 */
export function buildPluginDataAccountStoredContentUpgradeRequired():
    AccountStoredContentUpgradeRequiredV1 {
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            kind: 'account-stored-content',
            minimumProtocolVersion:
                ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
        },
    };
}

/**
 * V5 is a distinct staged operation. Its readiness is deliberately separate
 * from general stored-content admission: a V3/V4 peer can continue using its
 * established operations while every transition mutation is refused before a
 * transaction is opened.
 */
export function buildAccountEncryptionTransitionAccountStoredContentUpgradeRequired():
    AccountStoredContentUpgradeRequiredV1 {
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            kind: 'account-stored-content',
            minimumProtocolVersion:
                ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION,
        },
    };
}

export function evaluateAccountStoredContentCompatibility(
    parseResult: AccountStoredContentCompatibilityDeclarationParseResult,
): AccountStoredContentCompatibilityEvaluation {
    if (
        parseResult.status === 'missing'
        || parseResult.status === 'malformed'
    ) {
        return {
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: `legacy-${parseResult.status}`,
            declaration: null,
            upgradeRequired: buildAccountStoredContentUpgradeRequired(),
        };
    }

    const declaration = parseResult.declaration;
    if (
        declaration.protocolVersion
        < ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2
    ) {
        return {
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'legacy-protocol-too-old',
            declaration,
            upgradeRequired: buildAccountStoredContentUpgradeRequired(),
        };
    }

    return {
        supportsCurrentProtocol: true,
        supportsPluginDataProtocol:
            declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
        supportsSessionAccessWitnessProtocol:
            declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION,
        outcome: 'accepted',
        declaration,
        upgradeRequired: null,
    };
}

export function captureAccountStoredContentCompatibilityForHttpRequest(
    request: FastifyRequest,
): AccountStoredContentCompatibilityEvaluation {
    const evaluation = evaluateAccountStoredContentCompatibility(
        parseAccountStoredContentCompatibilityHttpHeadersV1(request.headers),
    );
    request.accountStoredContentCompatibility = evaluation;
    return evaluation;
}

export function readAccountStoredContentCompatibilityForHttpRequest(
    request: Pick<FastifyRequest, 'accountStoredContentCompatibility'>,
): AccountStoredContentCompatibilityEvaluation {
    return request.accountStoredContentCompatibility ?? {
        supportsCurrentProtocol: false,
        supportsPluginDataProtocol: false,
        supportsSessionAccessWitnessProtocol: false,
        outcome: 'legacy-missing',
        declaration: null,
        upgradeRequired: buildAccountStoredContentUpgradeRequired(),
    };
}

export async function enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<boolean> {
    const evaluation =
        readAccountStoredContentCompatibilityForHttpRequest(request);
    if (!evaluation.supportsCurrentProtocol) {
        await reply.code(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).send(
            evaluation.upgradeRequired
            ?? buildAccountStoredContentUpgradeRequired(),
        );
    }
    return !reply.sent;
}

/**
 * The staged Account encryption transition becomes reachable only when the
 * canonical server declaration has advanced to V5 and the caller explicitly
 * advertises V5. Keeping both facts at this owner prevents route-local flags
 * or a client-only version check from accidentally activating the operation.
 */
export async function enforceAccountEncryptionTransitionCompatibilityForHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<boolean> {
    const evaluation =
        readAccountStoredContentCompatibilityForHttpRequest(request);
    const serverSupportsTransition =
        CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS.currentProtocolVersion
        >= ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION;
    const clientSupportsTransition =
        evaluation.declaration !== null
        && evaluation.declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION;
    if (!serverSupportsTransition || !clientSupportsTransition) {
        await reply.code(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).send(
            buildAccountEncryptionTransitionAccountStoredContentUpgradeRequired(),
        );
    }
    return !reply.sent;
}

export function evaluateAccountStoredContentSocketCompatibility(
    auth: unknown,
): AccountStoredContentSocketCompatibilityResult {
    const parseResult =
        parseAccountStoredContentCompatibilitySocketAuthV1(auth);
    return {
        parseResult,
        evaluation: evaluateAccountStoredContentCompatibility(parseResult),
    };
}

export function writeAccountStoredContentCompatibilityForSocket(
    socket: Pick<Socket, 'data'>,
    compatibility: AccountStoredContentSocketCompatibilityResult,
): void {
    socket.data.accountStoredContentCompatibility =
        compatibility.evaluation;
}

export function readAccountStoredContentCompatibilityForSocket(
    socket: Readonly<{ data?: Socket['data'] }>,
): AccountStoredContentCompatibilityEvaluation {
    return socket.data?.accountStoredContentCompatibility ?? {
        supportsCurrentProtocol: false,
        supportsPluginDataProtocol: false,
        supportsSessionAccessWitnessProtocol: false,
        outcome: 'legacy-missing',
        declaration: null,
        upgradeRequired: buildAccountStoredContentUpgradeRequired(),
    };
}

export function buildAccountStoredContentSocketUpgradeError(
    evaluation: AccountStoredContentCompatibilityEvaluation,
): Error & { data: AccountStoredContentUpgradeRequiredV1 } {
    const error = new Error(
        CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    ) as Error & { data: AccountStoredContentUpgradeRequiredV1 };
    error.data =
        evaluation.upgradeRequired
        ?? buildAccountStoredContentUpgradeRequired();
    return error;
}
