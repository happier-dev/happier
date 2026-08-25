import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

const runtimeControlKeys = [
  'refreshGoal',
  'setGoal',
  'clearGoal',
  'listVendorPlugins',
  'listSkills',
  'startInlineReview',
  'invalidateConnectedServiceAuthTransports',
  'applyConnectedServiceAuthGeneration',
  'readConnectedServiceRuntimeIdentity',
  'enableUsageLimitWaitResume',
  'cancelUsageLimitWaitResume',
  'checkUsageLimitRecoveryNow',
  'consumeUsageLimitResetCredit',
  'clearTerminalComposer',
  'interruptPendingInputAndRun',
  'handleUserMessage',
  'preparePendingMessageComposerAdmission',
  'acceptPendingMessageComposerAdmission',
] as const satisfies readonly (keyof SessionRuntimeControls)[];

export function applySessionRuntimeControls(
  target: Partial<SessionRuntimeControls>,
  controls: SessionRuntimeControls | null,
): void {
  for (const key of runtimeControlKeys) {
    delete target[key];
  }
  if (!controls) return;
  for (const key of runtimeControlKeys) {
    const control = controls[key];
    if (typeof control === 'function') {
      target[key] = control as never;
    }
  }
}
