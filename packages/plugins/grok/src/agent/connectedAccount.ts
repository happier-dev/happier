import type { AgentConnectedAccountLaunchContributionV1, AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import type { XaiCredential } from '../connectedAccounts/credential.js';
import { isSessionId } from './externalSessions/source.js';

export const GROK_CONNECTED_ACCOUNT_MODE_ENV = 'GROK_CONNECTED_ACCOUNT_MODE';
export const GROK_OAUTH2_ISSUER_ENV = 'GROK_OAUTH2_ISSUER';
export type GrokConnectedAccountMode = XaiCredential['mode'];

export function readGrokConnectedAccountMode(environment: Readonly<Record<string, string>>): GrokConnectedAccountMode | undefined {
  const mode = environment[GROK_CONNECTED_ACCOUNT_MODE_ENV];
  if (mode === undefined) return undefined;
  if (mode === 'subscription' || mode === 'api-key') return mode;
  throw new Error('Selected Grok authentication mode is unavailable');
}

export async function verifyGrokResumeReachable(input: AgentConnectedAccountResumeReachabilityInputV1): Promise<AgentConnectedAccountResumeReachabilityResultV1> {
  const id = input.vendorResumeId;
  if (!id || !isSessionId(id)) return { ok: false, reason: 'grok_session_state_not_found' };
  let directory: string | undefined;
  await input.sessionFiles.findDeclaredCandidate({ includeNativeSessionId: false, matchesCandidate(candidate) {
    const segments = candidate.relativePath?.split('/');
    if (candidate.stateEntryPath !== 'sessions' || segments?.length !== 3 || segments[1] !== id || segments[2] !== 'chat_history.jsonl') return false;
    directory = `sessions/${segments.slice(0, -1).join('/')}`;
    return true;
  } });
  if (!directory) return { ok: false, reason: 'grok_session_state_not_found' };
  const verified = await input.sessionFiles.verifyDeclaredPaths({ paths: [
    { path: `${directory}/chat_history.jsonl`, kind: 'file' },
    { path: `${directory}/summary.json`, kind: 'json_object' },
    { path: directory, kind: 'directory' },
  ] });
  return verified.found ? { ok: true } : { ok: false, reason: 'grok_session_state_not_found' };
}


// The host copies non-secret configuration, projects selected auth, and owns this home's lifecycle.
export const GROK_CONNECTED_ACCOUNT_LAUNCH = {
  environmentUses: [GROK_CONNECTED_ACCOUNT_MODE_ENV, GROK_OAUTH2_ISSUER_ENV, 'GROK_OAUTH2_CLIENT_ID']
    .map(environmentKey => ({ purpose: 'primary', environmentKey })),
  environmentUnsetUses: [
    GROK_OAUTH2_ISSUER_ENV, 'GROK_OAUTH2_CLIENT_ID',
    'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_AUTH', 'GROK_AUTH_PATH',
    'GROK_AUTH_PROVIDER_COMMAND', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID',
    'GROK_OAUTH2_PRINCIPAL_TYPE', 'GROK_OAUTH2_PRINCIPAL_ID', 'GROK_LOCAL_AUTH',
  ].map(environmentKey => ({ purpose: 'primary', environmentKey })),
  switchContinuity: {
    continuityMode: 'restart_same_home', supportedTransitions: ['same_connected_group'],
    providerStateSharingRequired: {
      serviceIds: ['xai'],
      supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
    },
  },
  continuity: { generationApplicationScope: 'per_session_runtime', verifyResumeReachable: verifyGrokResumeReachable },
  stateSharingDescriptor: {
    nativeHome: {
      environmentKey: 'GROK_HOME', sourceEnvironmentKey: 'HAPPIER_GROK_NATIVE_HOME',
      defaultRelativePath: '.grok', materializedDirectoryName: 'grok-home', groupHome: 'selectedAccount',
    },
    providerSupportStatus: 'supported',
    config: { supported: true, modes: ['linked', 'copied', 'isolated'], entries: [
      { path: 'config.toml', mode: 'force_copied' },
      { path: 'AGENTS.md', mode: 'linked_or_copied' },
      { path: 'skills', mode: 'linked_or_copied' },
      { path: 'plugins', mode: 'linked_or_copied' },
    ] },
    state: { supported: true, modes: ['isolated', 'shared'], entries: [{ path: 'sessions', mode: 'linked', createIfMissing: 'directory' }],
      sharedStatePrivacyRiskAcknowledgementRequired: true, symlinkUnavailableDegradePolicy: 'block_continuity' },
    authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
    transforms: [{ entry: 'config.toml', kind: 'rewrite_toml', spec: {
      setStringValues: {},
      removeKeyPaths: [
        ['auth', 'auth_provider_command'], ['grok_com_config', 'auth_provider_command'],
        ['auth', 'oidc'], ['auth', 'oauth2'], ['grok_com_config', 'oidc'], ['grok_com_config', 'oauth2'],
        ['model', '*', 'api_key'], ['model', '*', 'env_key'],
      ],
      setStringValuesFromEnvironment: ['auth', 'grok_com_config'].flatMap(section => [
        { path: [section, 'preferred_method'], environmentKey: GROK_CONNECTED_ACCOUNT_MODE_ENV,
          values: { subscription: 'oidc', 'api-key': 'api_key' } },
      ]),
    } }],
  },
} as const satisfies AgentConnectedAccountLaunchContributionV1;
