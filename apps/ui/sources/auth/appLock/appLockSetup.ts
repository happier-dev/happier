import { TokenStorage } from '@/auth/storage/tokenStorage';
import { clearDeviceAccountData } from '@/auth/flows/clearDeviceAccountData';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import {
    apiAppLockRecoveryRedeem,
    apiAppLockRecoveryRegister,
    apiAppLockRecoveryRemove,
    apiAppLockRecoveryRequestResetCode,
    type AppLockRecoveryResult,
} from '@/sync/api/appLock/apiAppLockRecovery';

import {
    createAppLockKeys,
    generateAppLockRecoveryKey,
    rewrapAppLockPassword,
    rewrapAppLockRecoveryKey,
} from './appLockCrypto';
import { APP_LOCK_AUTO_LOCK_DEFAULT_MINUTES, type AppLockRecord } from './appLockRecord';
import {
    activateAppLock,
    deactivateAppLock,
    getAppLockDataKey,
    getAppLockSnapshot,
    unlockAppLockWithDataKey,
    unwrapAppLockDataKeyWithRecoveryKey,
    updateAppLockRecord,
    verifyAppLockPassword,
} from './appLockRuntime';
import { removeAppLockBiometricKey, storeAppLockBiometricKey } from './appLockBiometrics';

/** Turns the lock on for this device and re-seals every stored credential with the data key. */
export async function enableAppLockLocally(record: AppLockRecord, dataKey: Uint8Array): Promise<void> {
    await TokenStorage.transitionCredentialStorage(() => activateAppLock(record, dataKey));
}

/** Turns the lock off for this device and stores credentials in plain form again. */
export async function disableAppLockLocally(): Promise<void> {
    await TokenStorage.transitionCredentialStorage(() => deactivateAppLock());
}

function newLockId(): string {
    return encodeBase64(getRandomBytes(18), 'base64url');
}

/**
 * Turns the lock on: creates the keys, escrows the recovery key with the relay under the recovery
 * email, then seals this device's credentials. Nothing changes on the device if the relay refuses
 * (for example when the account has no mail settings yet).
 */
export async function enableAppLock(params: Readonly<{ email: string; password: string }>): Promise<AppLockRecoveryResult> {
    const keys = await createAppLockKeys(params.password);
    const record: AppLockRecord = {
        v: 1,
        lockId: newLockId(),
        email: params.email.trim(),
        serverUrl: getActiveServerUrl(),
        wrapped: keys.wrapped,
        autoLockMinutes: APP_LOCK_AUTO_LOCK_DEFAULT_MINUTES,
        biometric: false,
    };
    const registered = await apiAppLockRecoveryRegister({ lockId: record.lockId, email: record.email, recoveryKey: keys.recoveryKey });
    if (!registered.ok) return registered;
    await enableAppLockLocally(record, keys.dataKey);
    return { ok: true };
}

/**
 * Changes the recovery email of an unlocked device: a fresh escrow under a new lock id replaces the
 * old one, which is removed once the new one is stored.
 */
export async function changeAppLockEmail(email: string): Promise<AppLockRecoveryResult> {
    const record = getAppLockSnapshot().record;
    const dataKey = getAppLockDataKey();
    if (!record || !dataKey) return { ok: false, error: 'not_found' };
    const recoveryKey = generateAppLockRecoveryKey();
    const lockId = newLockId();
    const trimmed = email.trim();
    const registered = await apiAppLockRecoveryRegister({ lockId, email: trimmed, recoveryKey });
    if (!registered.ok) return registered;
    await updateAppLockRecord({
        ...record,
        lockId,
        email: trimmed,
        serverUrl: getActiveServerUrl(),
        wrapped: await rewrapAppLockRecoveryKey(record.wrapped, dataKey, recoveryKey),
    });
    const removed = await apiAppLockRecoveryRemove({ lockId: record.lockId });
    if (!removed.ok) {
        console.error(`[appLock] Could not remove the previous recovery record from the relay (${removed.error}); it will stay unused.`);
    }
    return { ok: true };
}

export async function changeAppLockPassword(currentPassword: string, newPassword: string): Promise<boolean> {
    const record = getAppLockSnapshot().record;
    const dataKey = getAppLockDataKey();
    if (!record || !dataKey || !(await verifyAppLockPassword(currentPassword))) return false;
    await updateAppLockRecord({ ...record, wrapped: await rewrapAppLockPassword(record.wrapped, dataKey, newPassword) });
    return true;
}

/** Turns the lock off after checking the password. The relay escrow is removed when reachable. */
export async function turnOffAppLock(password: string): Promise<boolean> {
    const record = getAppLockSnapshot().record;
    if (!record || !(await verifyAppLockPassword(password))) return false;
    const removed = await apiAppLockRecoveryRemove({ lockId: record.lockId });
    if (!removed.ok) {
        console.error(`[appLock] Could not remove the recovery escrow from the relay (${removed.error}); it will stay unused.`);
    }
    await removeAppLockBiometricKey();
    await disableAppLockLocally();
    return true;
}

export async function setAppLockAutoLockMinutes(minutes: number | null): Promise<void> {
    const record = getAppLockSnapshot().record;
    if (!record) return;
    await updateAppLockRecord({ ...record, autoLockMinutes: minutes });
}

/** Turns fingerprint unlock on (shows the system prompt) or off. */
export async function setAppLockBiometricEnabled(enabled: boolean, prompt: string): Promise<boolean> {
    const record = getAppLockSnapshot().record;
    const dataKey = getAppLockDataKey();
    if (!record) return false;
    if (!enabled) {
        await removeAppLockBiometricKey();
        await updateAppLockRecord({ ...record, biometric: false });
        return true;
    }
    if (!dataKey || !(await storeAppLockBiometricKey(dataKey, prompt))) return false;
    await updateAppLockRecord({ ...record, biometric: true });
    return true;
}

/** Lock screen: email a reset code to the recovery address. */
export async function requestAppLockResetCode(): Promise<AppLockRecoveryResult> {
    const record = getAppLockSnapshot().record;
    if (!record) return { ok: false, error: 'not_found' };
    return await apiAppLockRecoveryRequestResetCode(record.serverUrl, { lockId: record.lockId });
}

/** Lock screen: trade the emailed code for the recovery key, set a new password and unlock. */
export async function completeAppLockReset(code: string, newPassword: string): Promise<AppLockRecoveryResult> {
    const record = getAppLockSnapshot().record;
    if (!record) return { ok: false, error: 'not_found' };
    const redeemed = await apiAppLockRecoveryRedeem(record.serverUrl, { lockId: record.lockId, code });
    if (!redeemed.ok) return redeemed;
    const dataKey = await unwrapAppLockDataKeyWithRecoveryKey(redeemed.recoveryKey);
    if (!dataKey) return { ok: false, error: 'invalid_code' };
    await updateAppLockRecord({ ...record, wrapped: await rewrapAppLockPassword(record.wrapped, dataKey, newPassword) });
    unlockAppLockWithDataKey(dataKey);
    return { ok: true };
}

/**
 * Lock screen escape hatch: forget the password by signing this device out. Account data and
 * credentials are removed and the lock is turned off; the device must be connected to the account
 * again. The relay escrow cannot be removed without credentials and simply stays unused.
 */
export async function signOutLockedDevice(): Promise<void> {
    await clearDeviceAccountData();
    await removeAppLockBiometricKey();
    await deactivateAppLock();
}
