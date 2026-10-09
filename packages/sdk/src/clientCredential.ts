import { AccountApiTokenEncryptionAccessResponseV1Schema, parseAccountApiTokenBearerV1, parseAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { openApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { HappierClientClosedError, HappierTransportError } from './errors.js';
import type { ProtectedActionMaterial } from './machines.js';

export type ClientMachineMaterial =
  | Readonly<{ kind: 'plain' }>
  | Readonly<{ kind: 'account' | 'runner' | 'machine'; material: ProtectedActionMaterial }>;

/** One root-client secret lifetime, shared by every derived handle. */
export function createClientCredential(token: string) {
  const parsed = parseAccountApiTokenCredentialV1(token);
  const bearer = parsed?.bearer ?? token;
  const identity = parseAccountApiTokenBearerV1(bearer);
  if (identity === null || (token.startsWith('hapc_') && parsed === null)) {
    throw new TypeError('token must be an exact Happier API Token or encryption-capable credential');
  }
  if (parsed === null) return { bearer, encryption: undefined, dispose: () => undefined };

  const pins = { serverIdentityId: parsed.serverIdentityId, accountId: parsed.accountId,
    contentPublicKey: parsed.contentPublicKey, tokenId: identity.tokenId };
  const wrappingSecret = decodeBase64(parsed.wrappingSecret, 'base64url');
  let material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }> | undefined;
  let initialization: Promise<NonNullable<typeof material>> | undefined;
  /**
   * Only restricted Runner target selection has this credential lifetime. A
   * restricted Runner's content key is generated once for that Machine and
   * never rotated, and Machine ids are never reused, so a later request to the
   * same Machine reuses the resolved key instead of re-reading the bootstrap
   * projection.
   */
  const machineMaterial = new Map<string, Promise<ClientMachineMaterial>>();
  // Shared Machine material lives only while an invocation uses it, so the next
  // invocation sees recipient readiness and rotation from the current projection.
  const activeSharedMaterial = new Map<ProtectedActionMaterial, number>();
  let disposed = false;

  const getMaterial = (retrieve: () => Promise<unknown>) => {
    if (disposed) return Promise.reject(new HappierClientClosedError());
    if (material) return Promise.resolve(material);
    initialization ??= (async () => {
      try {
        const response = AccountApiTokenEncryptionAccessResponseV1Schema.safeParse(await retrieve());
        if (disposed) throw new HappierClientClosedError();
        const key = response.success && response.data.accountId === pins.accountId
          && response.data.tokenId === pins.tokenId
          ? openApiTokenEncryptionAccessV1({ context: pins, wrappingSecret,
            encryptionAccess: response.data.encryptionAccess }) : null;
        if (!key) throw new HappierTransportError('The API credential encryption material could not be opened.', {
          code: 'invalid_encrypted_envelope',
        });
        material = { type: 'dataKey', machineKey: key };
        return material;
      } catch (error) {
        initialization = undefined;
        throw error;
      }
    })();
    return initialization;
  };
  const getMachineMaterial = (
    machineId: string,
    resolve: () => Promise<ClientMachineMaterial>,
  ) => {
    if (disposed) return Promise.reject(new HappierClientClosedError());
    const resolved = machineMaterial.get(machineId);
    const pending = resolved ?? resolve().then((result) => {
      if (result.kind !== 'runner') machineMaterial.delete(machineId);
      if (disposed) {
        if (result.kind !== 'plain') result.material.machineKey.fill(0);
        throw new HappierClientClosedError();
      }
      return result;
    }).catch((error: unknown) => {
      machineMaterial.delete(machineId);
      throw error;
    });
    if (!resolved) machineMaterial.set(machineId, pending);
    return pending.then((result) => {
      if (disposed) throw new HappierClientClosedError();
      if (result.kind === 'machine') {
        activeSharedMaterial.set(result.material, (activeSharedMaterial.get(result.material) ?? 0) + 1);
      }
      return result;
    });
  };
  const releaseMachineMaterial = (resolved: ClientMachineMaterial) => {
    if (resolved.kind !== 'machine') return;
    const remaining = (activeSharedMaterial.get(resolved.material) ?? 1) - 1;
    if (remaining > 0) activeSharedMaterial.set(resolved.material, remaining);
    else {
      activeSharedMaterial.delete(resolved.material);
      resolved.material.machineKey.fill(0);
    }
  };
  return {
    bearer,
    encryption: { pins, getMaterial, getMachineMaterial, releaseMachineMaterial },
    dispose: () => {
      disposed = true;
      wrappingSecret.fill(0);
      material?.machineKey.fill(0);
      for (const pending of machineMaterial.values()) {
        void pending.then((resolved) => {
          if (resolved.kind !== 'plain') resolved.material.machineKey.fill(0);
        }, () => undefined);
      }
      for (const resolved of activeSharedMaterial.keys()) resolved.machineKey.fill(0);
      activeSharedMaterial.clear();
      machineMaterial.clear();
      material = undefined;
      initialization = undefined;
    },
  };
}

export type ClientCredential = ReturnType<typeof createClientCredential>;

/** Cancels only this waiter; the shared bootstrap retains its root lifetime. */
export function waitForClientMaterial<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
