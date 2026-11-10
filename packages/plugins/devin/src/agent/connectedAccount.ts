import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { DEVIN_NATIVE_FILE } from '../connectedAccounts/nativeCredentials.js';

export const DEVIN_NATIVE_PURPOSE = 'devin-native';
export function devinNativeHome(platform: string) {
  return {
    environmentKey: platform === 'win32' ? 'APPDATA' : 'XDG_DATA_HOME',
    defaultRelativePath: platform === 'win32' ? 'AppData/Roaming' : '.local/share',
    sourceEnvironmentKey: 'HAPPIER_DEVIN_NATIVE_DATA_HOME',
    materializedDirectoryName: 'data-home',
    groupHome: 'selectedAccount',
    materializedRootOverlay: { privateEntries: ['devin'] },
  } as const;
}

/** Data-root auth is independent of the declarative ACP config-root/MCP owner. */
export function createDevinConnectedAccountLaunch(platform = process.platform): AgentConnectedAccountLaunchContributionV1 {
  return {
    environmentUnsetUses: [{ purpose: DEVIN_NATIVE_PURPOSE, environmentKey: 'WINDSURF_API_KEY' }],
    switchContinuity: { continuityMode: 'restart_shared_state_required',
      supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected', 'same_connected_group'] },
    stateSharingDescriptor: {
      nativeHome: devinNativeHome(platform), providerSupportStatus: 'supported',
      // On Windows APPDATA contains both data and config. Only named non-auth
      // Devin config is shared; ACP composes its own private MCP file afterward.
      config: { supported: true, modes: ['linked', 'copied', 'isolated'], entries: platform === 'win32' ? [
        { path: 'devin/config.toml', mode: 'linked_or_copied' },
        { path: 'devin/mcp_config.json', mode: 'linked_or_copied' },
        { path: 'devin/skills', mode: 'linked_or_copied' },
      ] : [] },
      state: { supported: true, modes: ['isolated', 'shared'], entries: [
        { path: 'devin/cli', mode: 'linked', createIfMissing: 'directory' },
      ], sharedStatePrivacyRiskAcknowledgementRequired: true, symlinkUnavailableDegradePolicy: 'block_continuity' },
      authIsolation: { mode: 'materialized_home', secretEntries: [DEVIN_NATIVE_FILE] },
    },
    continuity: { generationApplicationScope: 'per_session_runtime',
      async verifyResumeReachable({ vendorResumeId, sessionFiles }) {
        if (!vendorResumeId) return { ok: false, reason: 'vendor_resume_id_missing' };
        // The native ACP session/load remains the Session-id authority in this
        // SQLite store. The host verifies the declared companion database exists.
        const result = await sessionFiles.verifyDeclaredPaths({ paths: [{ path: 'devin/cli/sessions.db', kind: 'file' }] });
        return result.found ? { ok: true } : { ok: false, reason: 'devin_session_state_not_found' };
      },
    },
  };
}
export const DEVIN_CONNECTED_ACCOUNT_LAUNCH = createDevinConnectedAccountLaunch();
