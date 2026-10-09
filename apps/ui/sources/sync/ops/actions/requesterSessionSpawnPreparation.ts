import { SessionRequesterBootstrapCredentialsV1Schema, SessionRequesterCreationContextV1Schema, projectRequesterSessionCredentialDisclosure, type SessionRequesterCreationContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MachineAccessGrantsListResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import type { LazyActionAccountContext } from './actionAccountContext';
import { Modal } from '@/modal';
import { t } from '@/text';

/** Confidentiality consent is separate from effect admission and contains no credential material. */
export async function confirmRequesterAccountCredentialDisclosure(params: Readonly<{
    accountContext: LazyActionAccountContext;
    machineId: string;
    custodian: Readonly<{ accountId: string; displayName?: string | null }>;
    signal?: AbortSignal;
}>): Promise<boolean> {
    params.accountContext.assertCurrent();
    const accepted = await Modal.confirm(t('common.warning'), [
        t('machineRequester.fullSignIn', { machine: params.machineId }),
        t('machineRequester.osVisibility', { owner: params.custodian.displayName || params.custodian.accountId,
            machine: params.machineId }),
    ].join('\n\n'), { confirmText: t('common.continue'), cancelText: t('common.cancel') });
    params.accountContext.assertCurrent();
    params.signal?.throwIfAborted();
    return accepted === true;
}

type RequesterSessionSpawnDisposition = Readonly<{ kind: 'own' }>
    | Readonly<{ kind: 'requester'; disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure> & Readonly<{ custodian: Readonly<{ accountId: string; displayName?: string | null }> }> }>
    | Readonly<{ kind: 'refused'; result: Extract<SessionSpawnNewResultV1, { type: 'error' }> }>;

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

/** The private credential codec follows Account mode, not stale local key presence. */
export function serializeRequesterAccountCredentials(accountMode: 'plain' | 'e2ee', credentials: AuthCredentials) {
    return SessionRequesterBootstrapCredentialsV1Schema.parse({
        token: credentials.token,
        ...(accountMode === 'e2ee' && 'secret' in credentials ? { secret: encodeBase64(decodeBase64(credentials.secret, 'base64url'), 'base64') } : {}),
        ...(accountMode === 'e2ee' && 'encryption' in credentials ? { encryption: credentials.encryption } : {}),
    });
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
