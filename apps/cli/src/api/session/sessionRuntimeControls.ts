import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

// Pending custody controls belong to the client/transcript lifetime, not the host
// generation. All other members come directly from the typed installed source.
type ClientOwnedControl = 'wakePendingMaterialization' | 'preparePendingMessageComposerAdmission'
  | 'acceptPendingMessageComposerAdmission' | 'abandonPendingMessageComposerAdmission';
type InstalledRuntimeControls = Omit<SessionRuntimeControls, ClientOwnedControl>;

function installedRuntimeControls({
  wakePendingMaterialization: _wake,
  preparePendingMessageComposerAdmission: _admission,
  acceptPendingMessageComposerAdmission: _accepted,
  abandonPendingMessageComposerAdmission: _abandoned,
  ...controls
}: SessionRuntimeControls): InstalledRuntimeControls {
  return controls;
}

export function applySessionRuntimeControls(
  target: Partial<SessionRuntimeControls>,
  controls: SessionRuntimeControls | null,
): void {
  for (const key of Object.keys(installedRuntimeControls(target)) as (keyof InstalledRuntimeControls)[]) {
    delete target[key];
  }
  if (controls) Object.assign(target, installedRuntimeControls(controls));
}
