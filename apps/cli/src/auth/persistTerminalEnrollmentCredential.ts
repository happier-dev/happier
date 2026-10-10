import tweetnacl from 'tweetnacl';
import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

import { ApiClient } from '@/api/api';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import {
  writeCredentialsDataKey,
  writeCredentialsTokenOnly,
  type StoredCredentials,
} from '@/persistence';
import type { OpenTerminalProvisioningResponseResult } from '@/auth/terminalProvisioningResponse';
import { ensureMachineIdForCredentials } from '@/ui/auth';

export async function persistTerminalEnrollmentCredential(params: Readonly<{
  token: string;
  opened: OpenTerminalProvisioningResponseResult;
}>): Promise<Readonly<{
  credentials: StoredCredentials;
  encryptionType: 'dataKey' | 'tokenOnly';
}>> {
  const prepared = createTerminalEnrollmentCredential(params);
  const { encryption } = prepared.credentials;
  if (encryption?.type === 'dataKey') {
    await writeCredentialsDataKey({ publicKey: encryption.publicKey, machineKey: encryption.machineKey, token: params.token });
  } else {
    await writeCredentialsTokenOnly({ token: params.token });
  }
  return prepared;
}

export function createTerminalEnrollmentCredential(params: Readonly<{
  token: string;
  opened: OpenTerminalProvisioningResponseResult;
}>): Readonly<{ credentials: StoredCredentials; encryptionType: 'dataKey' | 'tokenOnly' }> {
  if (params.opened.type === 'dataKey') {
    const machineKey = params.opened.key;
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    return {
      credentials: {
        token: params.token,
        encryption: { type: 'dataKey', publicKey, machineKey },
      },
      encryptionType: 'dataKey',
    };
  }

  return {
    credentials: { token: params.token, encryption: null },
    encryptionType: 'tokenOnly',
  };
}

/** Both normal enrollment lifetimes enforce managed admission before saving a bearer. */
export async function registerAndPersistManagedTerminalEnrollmentCredential(params: Readonly<{
  token: string;
  opened: OpenTerminalProvisioningResponseResult;
  runtimeOrigin: string;
  managedEnrollment: ManagedEnrollmentCorrelationV1;
  assertCurrent(): void;
}>): Promise<Readonly<{ machineId: string; encryptionType: 'dataKey' | 'tokenOnly' }>> {
  params.assertCurrent();
  const prepared = createTerminalEnrollmentCredential(params);
  const machineId = await registerTerminalEnrollmentMachine(prepared.credentials, params.runtimeOrigin, params.managedEnrollment);
  params.assertCurrent();
  await persistTerminalEnrollmentCredential(params);
  return { machineId, encryptionType: prepared.encryptionType };
}

export async function registerTerminalEnrollmentMachine(
  credentials: StoredCredentials,
  runtimeOrigin: string,
  managedEnrollment?: ManagedEnrollmentCorrelationV1,
): Promise<string> {
  return await runWithServerHttpBaseUrl(runtimeOrigin, async () => {
    const { machineId } = await ensureMachineIdForCredentials(credentials);
    const api = await ApiClient.create(credentials);
    const registered = await ensureMachineRegistered({
      api,
      machineId,
      metadata: initialMachineMetadata,
      caller: 'auth.wait',
      ...(managedEnrollment ? { managedEnrollment } : {}),
    });
    return registered.machineId;
  });
}
