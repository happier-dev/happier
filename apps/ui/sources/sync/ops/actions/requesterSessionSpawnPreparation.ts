import { SessionRequesterBootstrapCredentialsV1Schema, SessionRequesterCreationContextV1Schema, projectRequesterSessionCredentialDisclosure, type SessionRequesterCreationContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MachineAccessGrantsListResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import type { LazyActionAccountContext } from './actionAccountContext';
type RequesterSessionSpawnDisposition = Readonly<{ kind: 'own' }>
    | Readonly<{ kind: 'requester'; disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure> & Readonly<{ custodian: Readonly<{ accountId: string; displayName?: string | null }> }> }>
    | Readonly<{ kind: 'refused'; result: Extract<SessionSpawnNewResultV1, { type: 'error' }> }>;

/** The inventory owner already classifies a known own Machine; uncertain custody still needs access. */
export async function readRequesterSessionSpawnDisposition(params: Readonly<{
    accountId: string;
    machineId: string;
    publishedAccess: Machine['access'];
    readAccess(): Promise<unknown>;
}>): Promise<RequesterSessionSpawnDisposition> {
    if (params.publishedAccess?.accessState === 'ready'
        && params.publishedAccess.custodian.accountId === params.accountId) return { kind: 'own' };
    return resolveRequesterSessionSpawnDisposition({ ...params, access: await params.readAccess() });
}

/** Current Home access selects credential custody only; C41 remains the admission authority. */
export function resolveRequesterSessionSpawnDisposition(params: Readonly<{
    accountId: string;
    machineId: string;
    access: unknown;
}>): RequesterSessionSpawnDisposition {
    const parsed = MachineAccessGrantsListResultV1Schema.safeParse(params.access);
    const unavailable = { kind: 'refused' as const, result: { type: 'error' as const, code: 'target_unavailable' as const, retryable: true } };
    if (!parsed.success) return unavailable;
    const access = parsed.data;
    if ('kind' in access) return { kind: 'refused', result: {
        type: 'error', code: access.code === 'machine_unavailable' ? 'target_unavailable' : 'permission_denied', retryable: false,
    } };
    if (access.machineId !== params.machineId || access.custodian.accountId !== access.access.custodian.accountId) return unavailable;
    if (access.access.accessState !== 'ready') return { kind: 'refused', result: {
        type: 'error', code: access.access.accessState === 'key_pending' ? 'session_data_key_unavailable' : 'permission_denied', retryable: false,
    } };
    return access.custodian.accountId === params.accountId ? { kind: 'own' } : { kind: 'requester', disclosure: {
        ...projectRequesterSessionCredentialDisclosure({ disposition: 'ordinary_requester', accountId: params.accountId, machineId: params.machineId }),
        custodian: access.custodian,
    } };
}

/**
 * The private credential codec follows Account mode, not stale local key presence.
 * Another person's Machine receives the Account content key, never the recovery
 * secret: the recovery secret signs in as the Account and survives sign-out.
 */
export function serializeRequesterAccountCredentials(accountMode: 'plain' | 'e2ee', credentials: AuthCredentials) {
    return SessionRequesterBootstrapCredentialsV1Schema.parse({
        token: credentials.token,
        ...(accountMode === 'e2ee' && 'secret' in credentials ? { encryption: contentKeyFromRecoverySecret(credentials.secret) } : {}),
        ...(accountMode === 'e2ee' && 'encryption' in credentials ? { encryption: credentials.encryption } : {}),
    });
}

function contentKeyFromRecoverySecret(secret: string) {
    const machineKey = resolveAccountContentSecretKey({ type: 'legacy', secret: decodeBase64(secret, 'base64url') });
    return {
        publicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey, 'base64'),
        machineKey: encodeBase64(machineKey, 'base64'),
    };
}

/** The private spawn wire shape follows the shared requester Account credential codec. */
export function buildRequesterSessionCreationContext(
    accountMode: 'plain' | 'e2ee',
    credentials: AuthCredentials,
): SessionRequesterCreationContextV1 {
    return SessionRequesterCreationContextV1Schema.parse({
        v: 1, disposition: 'ordinary_requester',
        credentials: serializeRequesterAccountCredentials(accountMode, credentials),
    });
}

/** Original-Home key holder preparation, after Action admission and before private Machine dispatch. */
export async function prepareRequesterSessionForSpawn(params: Readonly<{
    accountContext: LazyActionAccountContext;
}>): Promise<SessionRequesterCreationContextV1> {
    const context = params.accountContext;
    context.assertCurrent();
    const { accountMode } = await context.resolveAccountEncryption();
    context.assertCurrent();
    return buildRequesterSessionCreationContext(accountMode, context.credentials);
}
