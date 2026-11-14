import type { CliActionDepsParams } from './types';
import type { CliProjectAdmission } from './projectAdmission';
import type { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import axios from '@/api/client/credentialAxios';
import type { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { MachineDeploymentReferencesPageV1Schema, readMachineReferenceCensusV1, type MachineReferenceCensusV1,
  type MachineDeploymentReferencesInputV1, type MachineDeploymentReferencesPageV1,
  type MachineReferencePoolListV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { ManagedGetInputV1Schema, ManagedGetOutputV1Schema, managedMachineActionEndpointPathV1,
  unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePoolListOutputV1Schema, type MachinePoolListOutputV1 } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import type { listAutomationDefinitions } from '@/api/automations';
import type { createCliProfileStore, createCliProfileStoreForOperation } from '@/settings/profiles/profileStore';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import type { readSettings, StoredCredentials } from '@/persistence';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deriveCliPrivateLabelAccountKey, openCliMachinePoolPrivateViews } from '@/api/privateLabels';

async function readDeploymentReferencePage(serverUrl: string, input: MachineDeploymentReferencesInputV1,
  headers: ReturnType<typeof buildCurrentAccountStoredContentCompatibilityHttpHeaders> & Readonly<{ Authorization: string }>,
  signal?: AbortSignal): Promise<MachineDeploymentReferencesPageV1> {
  const response = await axios.get(`${serverUrl}/v1/deployments/machine-references`, { headers, signal, params: input });
  return MachineDeploymentReferencesPageV1Schema.parse(response.data);
}

/** The reference census accepts only locally opened Pool names, never the wire projection. */
export function openCliMachineReferencePoolList(input: Readonly<{
  raw: MachinePoolListOutputV1;
  credentials: StoredCredentials;
  accountContentEncryptionMode: 'plain' | 'e2ee';
}>): MachineReferencePoolListV1 | null {
  const requiresAccountKey = input.raw.pools.some(({ pool }) => [pool.name, pool.description]
    .some((projection) => projection !== null && projection.kind === 'available'
      && projection.label.content.t === 'encrypted'));
  const accountKey = requiresAccountKey ? deriveCliPrivateLabelAccountKey(input.credentials.encryption) : null;
  try {
    return openCliMachinePoolPrivateViews({
      views: input.raw.pools,
      accountContentEncryptionMode: input.accountContentEncryptionMode,
      ...(accountKey ? { accountKey } : {}),
    });
  } finally {
    accountKey?.fill(0);
  }
}

/** Exact requester role read, independent of managed-allocation/artifact/profile setup. */
export function createCliMachineRebootReferenceReader(params: Pick<CliActionDepsParams, 'credentials'>,
  owner: Readonly<{ machineReferenceServerUrl: string; projectHomeId: string;
    projectAccountAdmission: CliProjectAdmission['projectAccountAdmission'] }>): NonNullable<ActionExecutorDeps['machineRebootReferences']> {
  return async ({ input, context, cursor, signal }) => {
    if (!params.credentials || await owner.projectAccountAdmission(owner.projectHomeId, context)) throw new Error('requester_authority_unavailable');
    return await runWithServerHttpBaseUrl(owner.machineReferenceServerUrl, async () => {
      const { buildCurrentAccountStoredContentCompatibilityHttpHeaders } = await import('@/api/clientCompatibility/cliClientCompatibility');
      const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials!.token}` };
      const page = await readDeploymentReferencePage(owner.machineReferenceServerUrl, {
        homeId: owner.projectHomeId, machineId: input.machineId, ...(cursor ? { cursor } : {}),
      }, headers, signal);
      if (await owner.projectAccountAdmission(owner.projectHomeId, context)) throw new Error('requester_authority_unavailable');
      return page;
    });
  };
}

export function createCliManagedMachineReferences(
  params: Pick<CliActionDepsParams, 'credentials' | 'savedSecretOperationContext'>,
  { machineReferenceServerUrl, projectAccountAdmission, projectHomeId, readRawRoleSettings, roleArtifactStore }: Readonly<{
    machineReferenceServerUrl: string;
    projectAccountAdmission: CliProjectAdmission['projectAccountAdmission'];
    projectHomeId: string;
    readRawRoleSettings: ((options?: Readonly<{ requireCurrentNetwork: boolean }>) => Promise<Readonly<Record<string, unknown>>>) | undefined;
    roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
  }>,
): NonNullable<ActionExecutorDeps['managedMachineReferences']> {
  const managedMachineReferences: NonNullable<ActionExecutorDeps['managedMachineReferences']> = async ({ input, context, signal }) => {
    const unavailable = (reason: MachineReferenceCensusV1['unavailable'][number]): MachineReferenceCensusV1 => ({
      homeId: input.homeId, machineId: null, coverage: 'partial', references: [], unavailable: [reason],
    });
    if (await projectAccountAdmission(projectHomeId, context) || !params.credentials || !roleArtifactStore || !readRawRoleSettings) {
      return unavailable('requester_authority');
    }
    return await runWithServerHttpBaseUrl(machineReferenceServerUrl, async () => {
      const [{ buildCurrentAccountStoredContentCompatibilityHttpHeaders }, { listAutomationDefinitions }] = await Promise.all([import("@/api/clientCompatibility/cliClientCompatibility"), import("@/api/automations")]);
      const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials!.token}` };
      let machine: ReturnType<typeof unwrapManagedMachineReadV1>;
      try {
        const response = await axios.post(`${machineReferenceServerUrl}${managedMachineActionEndpointPathV1('machines.managed.get')}`,
          ManagedGetInputV1Schema.parse({ homeId: input.homeId, managedId: input.managedId }), { headers, signal });
        machine = unwrapManagedMachineReadV1(ManagedGetOutputV1Schema.parse(response.data));
        if (machine.homeId !== input.homeId || machine.id !== input.managedId) return unavailable('target');
      } catch { return unavailable('target'); }
      let profileStore: ReturnType<typeof createCliProfileStore> | undefined;
      return await readMachineReferenceCensusV1({ homeId: input.homeId, machineId: machine.enrolledMachineId ?? null,
        homeAliases: [projectHomeId], signal }, {
        artifacts: { ...roleArtifactStore, readMany: async (artifactIds, options) => {
          const rows = await roleArtifactStore.readBodies(artifactIds.map(artifactId => ({
            artifactId, ownerAccountId: '', access: 'view' as const, header: {}, headerVersion: 0,
            seq: 0, createdAt: 0, updatedAt: 0,
          })), options?.signal);
          return rows.map((row, index) => row.artifactId === artifactIds[index]
            && row.bodyVersion !== undefined && row.body !== undefined
            ? { artifactId: row.artifactId, header: row.header, body: row.body,
                ownerAccountId: row.ownerAccountId, access: row.access, publicAudience: row.publicAudience,
                headerVersion: row.headerVersion, revision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } }
            : null);
        } },
        readSettings: async () => {
          await readRawRoleSettings();
          const { createCliProfileStoreForOperation, createCliProfileStore } = await import("@/settings/profiles/profileStore");
          profileStore = params.savedSecretOperationContext
            ? createCliProfileStoreForOperation({ operationContext: params.savedSecretOperationContext, signal })
            : createCliProfileStore({ credentials: params.credentials!, signal });
          return (await profileStore.readSourceSnapshot()).raw;
        },
        readProfileCatalog: async () => {
          if (!profileStore) throw new Error('profile_catalog_unavailable');
          return await profileStore.readProfileCatalog();
        },
        readPools: async (): Promise<MachineReferencePoolListV1> => {
          const response = await axios.post(`${machineReferenceServerUrl}${machinePoolActionEndpointPathV1('machines.pools.list')}`, {}, { headers, signal });
          const raw = MachinePoolListOutputV1Schema.parse(response.data);
          const currentness = await fetchAccountEncryptionCurrentness({
            credentials: params.credentials!,
            token: params.credentials!.token,
            serverBaseUrl: machineReferenceServerUrl,
            signal,
          });
          const opened = openCliMachineReferencePoolList({
            raw,
            credentials: params.credentials!,
            accountContentEncryptionMode: currentness.mode,
          });
          if (!opened) throw new Error('machine_pool_private_label_unavailable');
          return opened;
        },
        readAssignments: cursor => listAutomationDefinitions({ token: params.credentials!.token, ...(cursor ? { cursor } : {}) }),
        readDeployments: selection => readDeploymentReferencePage(machineReferenceServerUrl, selection, headers, signal),
      });
    });
  };
  return managedMachineReferences;
}
