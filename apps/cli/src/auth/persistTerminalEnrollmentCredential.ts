import type { DeploymentAppMachineBindingV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import tweetnacl from 'tweetnacl';
import type { MachineEnrollmentCorrelationV1, ManagedEnrollmentMachineMetadataV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import { readMachineRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

import { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { writeAppliedMachineRoles } from '@/daemon/roles/machineRolesRuntime';
import {
  prepareCredentialsTokenOnlyForServerId,
  readSettings,
  readStoredCredentialCustodyForServerId,
  writeCredentialsDataKey,
  writeCredentialsTokenOnly,
  type StoredCredentials,
} from '@/persistence';
import type { OpenTerminalProvisioningResponseResult } from '@/auth/terminalProvisioningResponse';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { retryHomeOperation, type HomeOperationRetry } from '@/api/client/retryHomeOperation';

export async function persistTerminalEnrollmentCredential(params: Readonly<{
  token: string;
  opened: OpenTerminalProvisioningResponseResult;
  previousAccountId?: string | null;
}>): Promise<Readonly<{
  credentials: StoredCredentials;
  encryptionType: 'dataKey' | 'tokenOnly';
}>> {
  const prepared = createTerminalEnrollmentCredential(params);
  const { encryption } = prepared.credentials;
  if (encryption?.type === 'dataKey') {
    await writeCredentialsDataKey({ publicKey: encryption.publicKey, machineKey: encryption.machineKey, token: params.token });
  } else {
    await writeCredentialsTokenOnly({ token: params.token }, { previousAccountId: params.previousAccountId });
  }
  const credentials = await readStoredCredentialCustodyForServerId(configuration.activeServerId);
  if (!credentials || credentials.token !== params.token) throw new Error('Stored credential changed during terminal enrollment');
  return { ...prepared, credentials };
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
  managedEnrollment: MachineEnrollmentCorrelationV1;
  machineDisplayName?: string;
  initialMachineMetadata?: ManagedEnrollmentMachineMetadataV1;
  deploymentAppBinding?: DeploymentAppMachineBindingV1;
  homeRetry: HomeOperationRetry;
  assertCurrent(): void;
}>): Promise<Readonly<{ machineId: string; encryptionType: 'dataKey' | 'tokenOnly' }>> {
  params.assertCurrent();
  // Machine registration updates lastTokenSub. Capture the predecessor's scope
  // first so a tokenless historical key can never be rebound to a new Account.
  const previousAccountId = (await readSettings()).lastTokenSubByServerId?.[configuration.activeServerId] ?? null;
  params.assertCurrent();
  const prepared = createTerminalEnrollmentCredential(params);
  const credentials = prepared.encryptionType === 'tokenOnly'
    ? await prepareCredentialsTokenOnlyForServerId(configuration.activeServerId, { token: params.token }, { previousAccountId })
    : prepared.credentials;
  params.assertCurrent();
  const machineId = await registerTerminalEnrollmentMachine(credentials, params.runtimeOrigin, params.managedEnrollment, params.homeRetry, params.machineDisplayName, params.deploymentAppBinding, params.initialMachineMetadata);
  params.assertCurrent();
  await persistTerminalEnrollmentCredential({ ...params, previousAccountId });
  return { machineId, encryptionType: prepared.encryptionType };
}

export async function registerTerminalEnrollmentMachine(
  credentials: StoredCredentials,
  runtimeOrigin: string,
  managedEnrollment?: MachineEnrollmentCorrelationV1,
  homeRetry?: HomeOperationRetry,
  machineDisplayName?: string,
  deploymentAppBinding?: DeploymentAppMachineBindingV1,
  enrollmentMetadata?: ManagedEnrollmentMachineMetadataV1,
): Promise<string> {
  const register = async () => await runWithServerHttpBaseUrl(runtimeOrigin, async () => {
    const { machineId } = await ensureMachineIdForCredentials(credentials);
    const api = await ApiClient.create(credentials);
    const registered = await ensureMachineRegistered({
      api,
      machineId,
      metadata: { ...initialMachineMetadata, ...enrollmentMetadata,
        ...(machineDisplayName === undefined ? {} : { displayName: machineDisplayName }),
        ...(deploymentAppBinding === undefined ? {} : { deploymentApp: deploymentAppBinding }),
      },
      caller: 'auth.wait',
      ...(managedEnrollment ? { managedEnrollment } : {}),
    });
    if (enrollmentMetadata?.rolesV1) {
      // Startup applies this snapshot before the Machine can read Home or activate roles.
      // Registration is create-only: an existing Machine's explicit policy wins.
      const roles = readMachineRolesV1(registered.machine.metadata);
      if (roles.status !== 'ready' || roles.source !== 'stored') throw new Error('Machine roles unavailable at enrollment');
      await writeAppliedMachineRoles(configuration.activeServerId, registered.machineId, roles.policy.active);
    }
    return registered.machineId;
  });
  return await (homeRetry ? retryHomeOperation(homeRetry, register) : register());
}
