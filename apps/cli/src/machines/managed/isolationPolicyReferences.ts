import { readMachineProvisionerSessionPlacementV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';
import { ManagedMachinePresetGetResultV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { openManagedMachinePresetContentV1, type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import type { MachineIsolationConfiguredSandboxV1, MachineIsolationReferenceValidationV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import type { MachineTerminalOwnSessionReadRuntime } from '@/api/machine/rpcHandlers.terminal';
import { readRequesterAccountEncryptionMaterialSnapshot } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { createManagedPresetHydrator } from './presetHydration';
import { ManagedMachineControllerError } from './controllerErrors';
import { qualifyManagedOpaquePresetProvisionerV1 } from '@happier-dev/cli-common/machines/managed';

type IsolationTarget = Readonly<{ homeId: string; machineId: string; installationId: string }>;
type PresetReference = Pick<ManagedMachinePresetV1, 'id' | 'homeId' | 'controller' | 'archivedAt'>;

/** Placement belongs to the admitted declaration, evaluated against the opened saved launch. */
export function isMachineIsolationPresetReference(input: Readonly<{
  entry: MachineIsolationConfiguredSandboxV1; target: IsolationTarget; preset: PresetReference;
  launch: NonNullable<ManagedMachinePresetContentV1['launch']>; descriptor: MachineProvisionerContributionV1 | null;
}>): boolean {
  const { entry, target, preset, launch, descriptor } = input;
  const qualification = descriptor && qualifyManagedOpaquePresetProvisionerV1({ launch,
    provisioners: [{ contribution: entry.provisioner, descriptor }] });
  return preset.id === entry.presetId && preset.homeId === target.homeId && preset.archivedAt === undefined
    && (!preset.controller || preset.controller.machineId === target.machineId && preset.controller.installationId === target.installationId)
    && launch.provider.pluginId === entry.provisioner.pluginId && launch.provider.localId === entry.provisioner.localId
    && qualification?.kind === 'qualified' && qualification.provisioner.id === entry.provisioner.localId
    && readMachineProvisionerSessionPlacementV1(qualification.provisioner, launch.choices)?.kind === 'controller-local';
}

/** One save uses its admitted requester's Account and one captured admitted contribution catalog. */
export async function validateMachineIsolationConfiguredSandboxes(input: Readonly<{
  entries: MachineIsolationPolicyV1['configuredSandboxes']; target: IsolationTarget;
  runtime: MachineTerminalOwnSessionReadRuntime;
  provisioners: readonly Readonly<{ identity: MachineIsolationConfiguredSandboxV1['provisioner']; definition: MachineProvisionerContributionV1 }>[];
  signal: AbortSignal;
}>): Promise<MachineIsolationReferenceValidationV1> {
  const { runtime, target, signal } = input;
  if (signal.aborted || !await runtime.isCurrent?.()) return 'unavailable';
  const catalog = new Map(input.provisioners.map(entry => [buildQualifiedPluginContributionKey(entry.identity), entry.definition]));
  const authorization = runtime.accountAuthorization;
  const http = authorization?.requesterHttpProjection;
  if (authorization && !http || !authorization && !runtime.credentials) return 'unavailable';
  const hydrator = runtime.credentials
    ? createManagedPresetHydrator({ credentials: runtime.credentials, serverUrl: runtime.serverHttpBaseUrl }) : null;
  for (const entry of Object.values(input.entries)) {
    const descriptor = catalog.get(buildQualifiedPluginContributionKey(entry.provisioner));
    if (!descriptor || !descriptor.platforms.some(platform => platform === process.platform)) return 'invalid';
    const path = machinePresetActionEndpointPathV1('machines.presets.get');
    const body = { homeId: target.homeId, id: entry.presetId };
    const headers = http ? await http.createRequestHeaders({ effectActionId: authorization!.binding.actionId,
      method: 'POST', path, body, signal }) : runtime.credentials ? { Authorization: `Bearer ${runtime.credentials.token}` } : null;
    if (!headers) return 'unavailable';
    const response = await axios.post<unknown>(`${runtime.serverHttpBaseUrl.replace(/\/+$/, '')}${path}`, body, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers }, validateStatus: () => true, signal,
    }).catch(() => null);
    if (!response) return 'unavailable';
    const result = ManagedMachinePresetGetResultV1Schema.safeParse(response.data);
    if (!result.success) return 'unavailable';
    if (result.data.kind !== 'found') return 'invalid';
    if (response.status < 200 || response.status >= 300) return 'unavailable';
    const preset = result.data.preset;
    const accept = (opened: ManagedMachinePresetContentV1) => opened.launch
      && isMachineIsolationPresetReference({ entry, target, preset, launch: opened.launch, descriptor }) ? 'valid' as const : 'invalid' as const;
    if (hydrator) {
      const status = await hydrator.withPresetDefinition(preset, async opened => accept(opened), signal).catch(error => {
        if (error instanceof ManagedMachineControllerError && error.code === 'credential_unavailable') return 'locked' as const;
        throw error;
      });
      if (status !== 'valid') return status;
      continue;
    }
    if (preset.contentEncryptionMode === 'plain') {
      const opened = openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: preset.content });
      if (!opened) return 'locked';
      if (accept(opened) !== 'valid') return 'invalid';
      continue;
    }
    const snapshot = readRequesterAccountEncryptionMaterialSnapshot(authorization);
    if (!snapshot || !authorization) return 'unavailable';
    const accountKey = resolveAccountContentSecretKey(snapshot.material);
    try {
      const opened = openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'e2ee', content: preset.content,
        recipients: preset.recipients, accountId: runtime.accountId,
        accountKey });
      if (!opened) return 'locked';
      if (accept(opened) !== 'valid') return 'invalid';
    } finally { accountKey.fill(0); }
  }
  return 'valid';
}
