import type { ActionExecutorContext } from '@happier-dev/protocol';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readActiveMachineId } from '@/daemon/machineIdentity/machineRegistrationStore';

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Enriches the existing host context without changing its caller or authority. */
export async function enrichCliActionApprovalContext(input: Readonly<{
  context?: ActionExecutorContext;
  serverIdentityId?: string;
  machineId?: string | null;
  fixedServerId: string | null;
  resolveServerFeaturesSnapshot(): Promise<CliServerFeaturesSnapshot | undefined>;
}>): Promise<ActionExecutorContext> {
  let serverIdentityId = readNonEmptyString(input.context?.serverIdentityId)
    ?? readNonEmptyString(input.serverIdentityId);
  if (!serverIdentityId) {
    const snapshot = await input.resolveServerFeaturesSnapshot().catch(() => undefined);
    if (snapshot?.status === 'ready' && snapshot.provenance === 'authenticated') {
      serverIdentityId = normalizeServerIdentityIdCapability(
        snapshot.features.capabilities.serverIdentity?.serverIdentityId,
      ) ?? null;
    }
  }
  let machineId = readNonEmptyString(input.context?.defaultSessionMachineId)
    ?? readNonEmptyString(input.machineId);
  if (!machineId && input.fixedServerId === null) {
    machineId = await readActiveMachineId().catch(() => null);
  }
  return {
    ...(input.context ?? {}),
    ...(serverIdentityId ? { serverIdentityId } : {}),
    ...(machineId ? { defaultSessionMachineId: machineId } : {}),
  };
}
