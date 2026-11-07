import type { AccountSettings } from '@happier-dev/protocol';
import type { RequesterSessionRuntimeContext } from './requesterSessionCredentials';

export type RequesterAgentStartPolicyV1 = Readonly<Pick<AccountSettings,
  'workDepthLimit' | 'sessionAgentStartAllowListsV1' | 'sessionAgentSpawnPolicyV1'>>;

export function projectRequesterAgentStartPolicyV1(settings: AccountSettings): RequesterAgentStartPolicyV1 {
  return { workDepthLimit: settings.workDepthLimit,
    sessionAgentStartAllowListsV1: settings.sessionAgentStartAllowListsV1,
    sessionAgentSpawnPolicyV1: settings.sessionAgentSpawnPolicyV1 };
}

/** Read start policy from the admitted Account without demanding unrelated catalogs. */
export async function readRequesterAgentStartPolicyV1(input: Readonly<{
  runtime: RequesterSessionRuntimeContext;
  minSettingsVersion?: number;
  signal?: AbortSignal;
}>): Promise<RequesterAgentStartPolicyV1 | null> {
  const { runtime, signal } = input;
  if (!await runtime.bootstrap.refreshAccountSettings(input.minSettingsVersion, signal)
    || !await runtime.isCurrent(signal)) return null;
  return projectRequesterAgentStartPolicyV1(runtime.readAccountSettingsSnapshot().settings);
}
