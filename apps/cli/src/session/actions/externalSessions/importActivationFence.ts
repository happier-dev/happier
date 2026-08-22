import {
    EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1,
    EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
    ExternalSessionTakeoverStartInputV1Schema,
    type ActionExecuteResult,
    type ActionId,
} from '@happier-dev/protocol';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

function isPersistedTakeover(actionId: ActionId, input: unknown): boolean {
    if (actionId !== 'sessions.external.takeover') return false;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    return (input as { storageMode?: unknown }).storageMode === 'persisted';
}

function requiresPublicationFence(
    actionId: ActionId,
    input: unknown,
    requiredPublicationFenceVersion: number | undefined,
): boolean {
    if (actionId === 'sessions.external.materialize.start') return true;
    if (actionId === 'sessions.external.takeover.start') {
        const parsed = ExternalSessionTakeoverStartInputV1Schema.safeParse(input);
        // A start this owner cannot parse is not proven exempt from the fence.
        // Admitting it would let an unverified durable takeover start bypass
        // the runtime-bound hosted-admission requirement entirely.
        if (!parsed.success) return true;
        return parsed.data.request.targetStorageMode === 'persisted';
    }
    if (
        actionId === 'sessions.external.operation.resume'
        || actionId === 'sessions.external.operation.retry'
    ) {
        return requiredPublicationFenceVersion !== undefined;
    }
    return isPersistedTakeover(actionId, input);
}

function isUnsafeLegacyPersistedTakeover(actionId: ActionId, input: unknown): boolean {
    return isPersistedTakeover(actionId, input);
}

function supportsPublicationFence(
    serverSnapshot: CliServerFeaturesSnapshot | undefined,
    requiredVersion: number,
): boolean {
    if (serverSnapshot?.status !== 'ready') return false;
    const version = serverSnapshot.features.capabilities.session
        .externalImport
        ?.publicationFenceVersion;
    return typeof version === 'number'
        && version >= requiredVersion;
}

export function isExternalSessionHostedAdmissionAvailable(
    serverSnapshot: CliServerFeaturesSnapshot | undefined,
): boolean {
    return supportsPublicationFence(
        serverSnapshot,
        EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
    );
}

function buildUpgradeRequiredResult(actionId: ActionId): ActionExecuteResult {
    if (actionId === 'sessions.external.takeover') {
        return {
            ok: true,
            result: {
                ok: false,
                errorCode: 'upgrade_required',
                error: 'server_upgrade_required_for_external_session_import',
            },
        };
    }
    return {
        ok: true,
        result: {
            ok: false,
            error: {
                code: 'upgrade_required',
                message: 'Server upgrade required before external session import.',
            },
        },
    };
}

export function isExternalSessionImportActionAdmitted(params: Readonly<{
    actionId: ActionId;
    input: unknown;
    serverSnapshot: CliServerFeaturesSnapshot | undefined;
    requiredPublicationFenceVersion?: number;
}>): boolean {
    if (isUnsafeLegacyPersistedTakeover(params.actionId, params.input)) {
        return false;
    }
    return !requiresPublicationFence(
        params.actionId,
        params.input,
        params.requiredPublicationFenceVersion,
    )
        || supportsPublicationFence(
            params.serverSnapshot,
            params.requiredPublicationFenceVersion
            ?? (params.actionId === 'sessions.external.takeover.start'
                ? EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3
                : EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1),
        );
}

export async function executeExternalSessionImportActivation(params: Readonly<{
    actionId: ActionId;
    input: unknown;
    serverSnapshot: CliServerFeaturesSnapshot | undefined;
    requiredPublicationFenceVersion?: number;
    execute: () => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult> {
    if (!isExternalSessionImportActionAdmitted(params)) {
        return buildUpgradeRequiredResult(params.actionId);
    }
    return await params.execute();
}
