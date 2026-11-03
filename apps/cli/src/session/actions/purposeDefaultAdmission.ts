import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import type { ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { resolveConnectedAccountPurposeDefaultTargetV1, resolveConnectedAccountPurposeDefaultOriginV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { readCurrentMountedAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';

type PurposeTarget = Parameters<NonNullable<ConnectedServiceConfigurationActionHostV1['admitPurposeTarget']>>[0];
type AccountSelectionInput = Parameters<typeof readCurrentMountedAccountPluginExecutionSelection>[0];

/** Acquire one origin's declarations; Protocol owns declaration and profile admission. */
export async function admitCliConnectedAccountPurposeDefaultTarget(params: Readonly<{
  input: PurposeTarget;
  runtime: AccountSelectionInput['runtime'];
  signal?: AbortSignal;
  readProfile(): Promise<unknown>;
  readMachineProjection(machineId: string): Promise<unknown>;
}>): Promise<boolean> {
  const { input } = params;
  let declaration: Parameters<typeof resolveConnectedAccountPurposeDefaultTargetV1>[0]['declaration'];
  let readAuthentication: Parameters<typeof resolveConnectedAccountPurposeDefaultTargetV1>[0]['readAuthentication'];
  let accountServiceSelection: Parameters<typeof resolveConnectedAccountPurposeDefaultTargetV1>[0]['accountServiceSelection'];
  const origin = resolveConnectedAccountPurposeDefaultOriginV1(input);
  if (origin.kind === 'machine') {
    let rawProjection: unknown;
    try { rawProjection = await params.readMachineProjection(origin.machineId); }
    catch { return false; }
    const described = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(rawProjection);
    if (!described.success) return false;
    const projection = described.data.projection;
    declaration = { purpose: input.purpose, projection,
      machineProvisionersById: projection.familiesById.machineProvisioners?.entriesById ?? {} };
    const descriptors = Object.values(projection.familiesById.connectedAccounts?.entriesById ?? {}).flatMap(entry => {
      const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
      return parsed.success && parsed.data.availability.state === 'available' ? [parsed.data] : [];
    });
    readAuthentication = service => {
      const matching = descriptors.filter(descriptor => descriptor.pluginId === service.pluginId && descriptor.serviceId === service.localId);
      return matching.length === 1 ? matching[0]!.authentication : null;
    };
  } else {
    const { readCurrentMountedAccountPluginExecutionSelection } = await import('@/plugins/runtime/accountPluginActivationSource');
    const readSelection = (pluginId: string) => readCurrentMountedAccountPluginExecutionSelection({
      pluginId, runtime: params.runtime, ...(params.signal ? { signal: params.signal } : {}),
    });
    try {
      const selection = await readSelection(input.purpose.consumer.pluginId);
      if (selection.kind !== 'available') return false;
      declaration = { purpose: input.purpose, accountSelection: selection };
      if (input.target.kind === 'group' && input.target.service.pluginId !== input.purpose.consumer.pluginId) {
        accountServiceSelection = await readSelection(input.target.service.pluginId);
      }
    } catch { return false; }
  }
  let rawProfile: unknown;
  try { rawProfile = await params.readProfile(); }
  catch { return false; }
  const profile = AccountProfileSchema.safeParse(rawProfile);
  return profile.success && resolveConnectedAccountPurposeDefaultTargetV1({ declaration, target: input.target,
    accounts: profile.data.connectedAccountsV4, groups: profile.data.connectedAccountGroupsV4,
    accountServiceSelection, readAuthentication, now: Date.now() }) !== null;
}
