import type { AgentSessionConfigurationSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';

// CodeBuddy's --settings overlay selects the Bash sandbox without changing
// its separately configured permission mode or saved settings.
export function codeBuddyNativeSandboxSettings(nativeSandbox: AgentSessionConfigurationSnapshot['nativeSandbox']) {
  return nativeSandbox === undefined ? {} : { sandbox: { enabled: nativeSandbox === 'on' } };
}
