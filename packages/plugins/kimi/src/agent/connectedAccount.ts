import type { AgentConnectedAccountLaunchContributionV1, AgentConnectedAccountResumeReachabilityInputV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export async function verifyResumeReachableKimi(input: AgentConnectedAccountResumeReachabilityInputV1) {
  const id = input.vendorResumeId;
  if (!id || id === '.' || id === '..' || /[/\\]/u.test(id)) return { ok: false as const, reason: 'kimi_session_state_not_found' };
  const candidate = await input.sessionFiles.findDeclaredCandidate({ includeNativeSessionId: false,
    matchesCandidate: value => value.stateEntryPath === 'sessions' && value.relativePath?.split('/').slice(-2).join('/') === `${id}/state.json` });
  return candidate.found ? { ok: true as const } : { ok: false as const, reason: 'kimi_session_state_not_found' };
}

export const KIMI_CONNECTED_ACCOUNT_LAUNCH = {
  environmentUses: [{ purpose: 'primary', environmentKey: 'HAPPIER_KIMI_ACCESS_TOKEN' }],
  environmentUnsetUses: ['KIMI_CODE_BASE_URL', 'KIMI_CODE_OAUTH_HOST', 'KIMI_OAUTH_HOST', 'KIMI_API_KEY', 'MOONSHOT_API_KEY']
    .map(environmentKey => ({ purpose: 'primary', environmentKey })),
  switchContinuity: { continuityMode: 'restart_shared_state_required',
    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected', 'same_connected_group'] },
  stateSharingDescriptor: {
    nativeHome: { environmentKey: 'KIMI_CODE_HOME', defaultRelativePath: '.kimi-code', materializedDirectoryName: 'kimi-code' },
    providerSupportStatus: 'supported',
    config: { supported: true, modes: ['linked', 'copied', 'isolated'], entries: [{ path: 'config.toml', mode: 'force_copied' }] },
    state: { supported: true, modes: ['isolated', 'shared'],
      entries: [{ path: 'sessions', mode: 'linked', createIfMissing: 'directory' }, { path: 'session_index.jsonl', mode: 'linked', createIfMissing: 'file' }],
      sharedStatePrivacyRiskAcknowledgementRequired: true, symlinkUnavailableDegradePolicy: 'block_continuity' },
    authIsolation: { mode: 'materialized_home', secretEntries: ['config.toml'] },
  },
  continuity: { generationApplicationScope: 'per_session_runtime', verifyResumeReachable: verifyResumeReachableKimi },
} as const satisfies AgentConnectedAccountLaunchContributionV1;
