import {
    AccountSettingsV2HistoryDetailResponseSchema,
    applyAccountSettingsHistoryRestoreV1,
    type AccountSettingsHistoryRestoreInvalidReasonV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { serverFetch } from '@/sync/http/client';
import {
    openAccountSettingsStoredContent,
    type OpenedAccountSettingsStoredContent,
} from '@/sync/domains/settings/accountSettingsNormalization';

import { syncSettings } from './syncSettings';

/**
 * Client-side classification-aware Account Settings history restore (SET-07).
 *
 * This adapter owns exactly the realm facts the pure Protocol merge cannot:
 * fetching the recorded historical envelope, opening it in its RECORDED mode
 * (a snapshot stored before an encryption-mode transition still opens), and
 * submitting the merged document through the ordinary one-shot whole-document
 * CAS — which reseals to the CURRENT Account mode and applies the ordinary
 * local projection. There is no second restore writer: the retired
 * server-side exact-content restore keeps failing closed with
 * `account_settings_restore_client_update_required`.
 *
 * Restore is one-shot and never replayed: the merged document is computed once
 * against the freshest server baseline inside `syncSettings`' CAS callback, so
 * a version move is a typed conflict rather than a rewritten history.
 */

export type AccountSettingsHistoryRestoreResult =
    | Readonly<{ status: 'applied'; settingsVersion: number }>
    | Readonly<{ status: 'unchanged'; settingsVersion: number }>
    | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }>;

/** The historical snapshot exists but cannot serve a valid restore. */
export class AccountSettingsHistoryRestoreUnavailableError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'AccountSettingsHistoryRestoreUnavailableError';
        this.status = status;
    }
}

/**
 * The merged document refused a current classification/bound, so nothing was
 * written. Restore never substitutes a default or rewinds a legacy root.
 */
export class AccountSettingsHistoryRestoreInvalidError extends Error {
    readonly reason: AccountSettingsHistoryRestoreInvalidReasonV1;

    constructor(reason: AccountSettingsHistoryRestoreInvalidReasonV1) {
        super(`Account Settings history restore refused the merged document (${reason})`);
        this.name = 'AccountSettingsHistoryRestoreInvalidError';
        this.reason = reason;
    }
}

async function fetchHistorySnapshot(credentials: AuthCredentials, version: number) {
    const response = await serverFetch(`/v2/account/settings/history/${version}`, {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    }, { includeAuth: false });
    if (!response.ok) {
        throw new AccountSettingsHistoryRestoreUnavailableError(
            response.status,
            `Failed to fetch account settings history snapshot (${response.status})`,
        );
    }
    const data: unknown = await response.json();
    const parsed = AccountSettingsV2HistoryDetailResponseSchema.safeParse(data);
    if (!parsed.success) {
        throw new AccountSettingsHistoryRestoreUnavailableError(
            response.status,
            'Account settings history snapshot response is invalid',
        );
    }
    return parsed.data;
}

export type RestoreAccountSettingsFromHistorySnapshotParams = Readonly<{
    credentials: AuthCredentials;
    encryption: Encryption | null;
    /** The historical snapshot version to restore. */
    historyVersion: number;
    /**
     * The current Account Settings version the caller restored from. One-shot:
     * a moved version returns `conflict` with the current version.
     */
    expectedSettingsVersion: number;
    settingsScope?: AccountSettingsScope | null;
    settingsSecretsKey?: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
}>;

export async function restoreAccountSettingsFromHistorySnapshot(
    params: RestoreAccountSettingsFromHistorySnapshotParams,
): Promise<AccountSettingsHistoryRestoreResult> {
    const detail = await fetchHistorySnapshot(params.credentials, params.historyVersion);

    // Open in the RECORDED mode — no expected mode is asserted — so a snapshot
    // recorded before an Account encryption-mode transition still opens. The
    // ordinary writer below reseals the merged document to the CURRENT mode.
    let opened: OpenedAccountSettingsStoredContent;
    try {
        opened = openAccountSettingsStoredContent({
            content: detail.content,
            encryption: params.encryption,
        });
    } catch (error) {
        throw new AccountSettingsHistoryRestoreUnavailableError(
            0,
            error instanceof Error ? error.message : 'Historical snapshot cannot be opened',
        );
    }
    const historicalRaw = opened.raw ?? {};

    const result = await syncSettings({
        credentials: params.credentials,
        encryption: params.encryption,
        settingsScope: params.settingsScope ?? null,
        settingsSecretsKey: params.settingsSecretsKey ?? null,
        settingsSecretsReadKeys: params.settingsSecretsReadKeys,
        // Restore never carries pending deltas: unflushed pending settings make
        // the one-shot path fail closed instead of mixing into history restore.
        pendingSettings: {},
        clearPendingSettings: () => {},
        oneShotServerSettingsMutation: {
            expectedSettingsVersion: params.expectedSettingsVersion,
            mutate: (latestRaw) => {
                const application = applyAccountSettingsHistoryRestoreV1(latestRaw, historicalRaw);
                if (application.status === 'invalid') {
                    throw new AccountSettingsHistoryRestoreInvalidError(application.reason);
                }
                return {
                    settings: application.raw as Record<string, unknown>,
                    value: {
                        restoredFromHistoryVersion: detail.version,
                        mergeStatus: application.status,
                    } as const,
                };
            },
        },
    });
    // The one-shot mutation path always settles with a typed result.
    if (!result) {
        throw new AccountSettingsHistoryRestoreUnavailableError(0, 'Restore produced no result');
    }

    if (result.status === 'conflict') {
        return Object.freeze({
            status: 'conflict',
            currentSettingsVersion: result.currentSettingsVersion,
        });
    }
    if (result.status === 'outcomeUnknown') {
        return Object.freeze({
            status: 'outcomeUnknown',
            lastKnownSettingsVersion: result.lastKnownSettingsVersion,
        });
    }
    // The pure classification merge owns unchanged/applied. The one-shot
    // writer skips the POST for `unchanged`, so it never creates a history
    // entry merely because a server happened to reuse or alter version rules.
    const unchanged = result.value.mergeStatus === 'unchanged';
    return Object.freeze({
        status: unchanged ? 'unchanged' : 'applied',
        settingsVersion: result.settingsVersion,
    });
}
