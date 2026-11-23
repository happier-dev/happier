import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import { clearServerAccountChangesCursors } from '@/persistence';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';

export async function clearServerScopedAuthState(serverId: string): Promise<void> {
  if (!serverId.trim()) return;
  const target = sanitizeServerIdForFilesystem(serverId, 'cloud');
  await clearServerAccountChangesCursors(target);
  await updateMachineRegistration(() => ({}), target);
}
