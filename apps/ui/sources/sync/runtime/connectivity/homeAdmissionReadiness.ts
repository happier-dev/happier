import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { HomeCarrierPolicyError } from "@happier-dev/cli-common/homeEnrollment";
import { IrohError } from '@happier-dev/iroh-native';
import {
    AnyClientUpgradeRequiredV1Schema,
    CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
    type AnyClientUpgradeRequiredV1,
} from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { OperationUpdateRequiredV1Schema, type OperationUpdateRequiredV1 } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';

import type { AccountEncryptionCurrentnessErrorResponse } from '@happier-dev/protocol/account/encryptionMode';

import { HappyError } from '@/utils/errors/errors';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { AppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { HomeAdmissionSnapshot } from '@/sync/store/domains/realtime';
import type { AcquiredHomeCarrier } from '@/sync/runtime/homeCarrierPolicy';

import { isAuthenticationResponseStatus } from './authErrors';
import { readServerUnreachableFetchCode, SERVER_UNREACHABLE_ERROR_CODE } from './transientConnectivityErrors';

type CarrierSelection = Extract<AcquiredHomeCarrier, { kind: 'https' | 'native_iroh' | 'browser_iroh' }>['kind'];

export type HomeAdmissionVerdict =
    | Readonly<{ kind: 'connecting' | 'ready' }>
    | Readonly<{ kind: 'selected'; carrier: CarrierSelection }>
    | Readonly<{ kind: 'unavailable'; code: string; carrier?: 'iroh'; retryable: true }>
    | Readonly<{ kind: 'fail_closed'; code: string; fallbackAllowed: boolean; retryable: false }>
    | Readonly<{ kind: 'offline'; code: typeof SERVER_UNREACHABLE_ERROR_CODE; retryable: true }>
    | Readonly<{ kind: 'auth_failed'; code: 'unauthorized' | 'forbidden' | 'credential_scope_retired'; status?: 401 | 403; retryable: false }>
    | Readonly<{ kind: 'refused'; code: 'credential_request_redirect_refused' | 'account-encryption-currentness-unavailable'
        | AccountEncryptionCurrentnessErrorResponse['recipientEnvelopeReadiness']['reason']; status?: number; retryable: false }>
    | Readonly<{ kind: 'update_required'; status: number; requirement: AnyClientUpgradeRequiredV1 | OperationUpdateRequiredV1; retryable: false }>
    | Readonly<{ kind: 'transient'; status?: number; code: 'account-encryption-currentness-unavailable'; retryable: true }>;

type HomeAdmissionFailure = Extract<HomeAdmissionVerdict, { retryable: boolean }>;

export type HomeAdmissionReadObservation = Readonly<{
    publish: (verdict: HomeAdmissionVerdict) => void;
    isCurrent: () => boolean;
}>;

export function homeAdmissionCarrierVerdict(selection: AcquiredHomeCarrier): HomeAdmissionVerdict {
    if (selection.kind !== 'fail_closed' && selection.kind !== 'unavailable') {
        return { kind: 'selected', carrier: selection.kind };
    }
    const error = selection.error;
    const code = error instanceof HomeCarrierPolicyError || error instanceof IrohError
        ? error.code
        : error instanceof CredentialRequestRedirectError ? error.code : selection.kind;
    return selection.kind === 'fail_closed'
        ? { kind: selection.kind, code, fallbackAllowed: selection.fallbackAllowed, retryable: false }
        : { kind: selection.kind, code, retryable: true,
            ...(error instanceof IrohError ? { carrier: 'iroh' as const } : {}) };
}

export async function readHomeAdmissionExplicitRefusal(response: Response): Promise<HomeAdmissionFailure | null> {
    const { status } = response;
    const body = await response.clone().json().catch((): unknown => null);
    if (isAuthenticationResponseStatus(status)) {
        const code = body && typeof body === 'object' && 'error' in body && body.error === 'credential_scope_retired'
            ? body.error : status === 401 ? 'unauthorized' : 'forbidden';
        return { kind: 'auth_failed', status, code, retryable: false };
    }
    if (status === CLIENT_UPGRADE_REQUIRED_HTTP_STATUS) {
        const upgrade = AnyClientUpgradeRequiredV1Schema.safeParse(body);
        if (upgrade.success) return { kind: 'update_required', status, requirement: upgrade.data, retryable: false };
    }
    const operationUpdate = OperationUpdateRequiredV1Schema.safeParse(body);
    if (operationUpdate.success) {
        return { kind: 'update_required', status, requirement: operationUpdate.data, retryable: false };
    }
    return null;
}

export function readHomeAdmissionRequestRejection(error: unknown): HomeAdmissionFailure | null {
    if (error instanceof CredentialRequestRedirectError) {
        return { kind: 'refused', code: error.code, status: error.status, retryable: error.retryable };
    }
    if (error instanceof HappyError && error.code === 'account-encryption-currentness-unavailable') {
        const { code, status } = error;
        return error.canTryAgain ? { kind: 'transient', status, code, retryable: true }
            : { kind: 'refused', status, code, retryable: false };
    }
    const code = readServerUnreachableFetchCode(error);
    return code ? { kind: 'offline', code, retryable: true } : null;
}

export function selectHomeAdmission(
    admission: HomeAdmissionSnapshot | null,
    target: HomeAdmissionSnapshot['target'],
): HomeAdmissionSnapshot | null {
    return admission?.target.serverId === target.serverId
        && admission.target.serverUrl === target.serverUrl
        && admission.target.generation === target.generation ? admission : null;
}

export function readHomeAdmission(target: AppliedActiveServerSnapshot): HomeAdmissionSnapshot | null {
    return selectHomeAdmission(readRegisteredStorageState()?.homeAdmission ?? null, target);
}

export function hasPendingHomeAdmission(): boolean {
    return readRegisteredStorageState()?.homeAdmission != null;
}

export function clearHomeAdmission(): void {
    readRegisteredStorageState()?.setHomeAdmission(null);
}

/** Publish the restore owner's observed result while there is no applied runtime. */
export function publishHomeAdmission(
    { serverId, serverUrl, generation }: AppliedActiveServerSnapshot,
    verdict: HomeAdmissionVerdict,
): void {
    readRegisteredStorageState()?.setHomeAdmission({ target: { serverId, serverUrl, generation }, verdict });
}
