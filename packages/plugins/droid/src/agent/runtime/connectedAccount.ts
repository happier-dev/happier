import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type { AgentConnectedAccountLaunchContributionV1, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';

import { KIMI_CONNECTED_ACCOUNT_SERVICE, KIMI_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV } from '@happier-dev/plugins-kimi/connected-account-service';
import { GROK_CONNECTED_ACCOUNT_SERVICE, XAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-grok/connected-account-service';
import { ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, ANTHROPIC_API_KEY_ENV } from '@happier-dev/plugins-claude/connected-account-service';
import { OPENAI_CONNECTED_ACCOUNT_SERVICE, OPENAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-openai/connected-account-service';

import { buildDroidModelSettings, droidSettingsCommandArgs, DROID_NATIVE_AUTH_ENV_KEY, DROID_PROVIDER_SECRET_ENV } from '../providerBinding/settings.js';

export const DROID_CHATGPT_PURPOSE = 'openai-codex';

export const DROID_NATIVE_KEY_PURPOSES = [
  { purpose: 'anthropic-api-key', service: ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, environmentKey: ANTHROPIC_API_KEY_ENV, baseUrl: 'https://api.anthropic.com', provider: 'anthropic' },
  { purpose: 'openai-api-key', service: OPENAI_CONNECTED_ACCOUNT_SERVICE, environmentKey: OPENAI_SELECTED_API_KEY_ENV, baseUrl: 'https://api.openai.com/v1', provider: 'generic-chat-completion-api' },
  { purpose: 'kimi-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE, environmentKey: KIMI_CODE_API_KEY_ENV, baseUrlEnvironmentKey: KIMI_CODE_API_BASE_ENV, provider: 'generic-chat-completion-api' },
  { purpose: 'xai-api-key', service: GROK_CONNECTED_ACCOUNT_SERVICE, environmentKey: XAI_SELECTED_API_KEY_ENV, baseUrl: 'https://api.x.ai/v1', provider: 'generic-chat-completion-api' },
] as const;
export const DROID_CONNECTED_ACCOUNT_PURPOSES = [
  ...DROID_NATIVE_KEY_PURPOSES.map(({ purpose, service }) => ({ purpose, service, credentialKinds: ['token'] as const, materializationKinds: ['environment'] as const })),
];

type LaunchRequest = Pick<AgentSessionOpenRequest, 'providerBinding' | 'launchEnvironment' | 'connectedAccounts'>;
export type DroidConnectedAccountLaunch<Request extends LaunchRequest> = Readonly<{
  request: Request;
  customModel?: Readonly<{ model: Readonly<{ id: string; name: string }>;
    commandArgsSuffix: readonly string[]; catalogConfidence: 'account_unverified' }>;
  dispose(): void;
}>;

export async function prepareDroidConnectedAccount<Request extends LaunchRequest>(
  request: Request,
  context: Readonly<{ services: { connectedAccounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> }; signal?: AbortSignal }>,
  modelId?: string | null,
): Promise<DroidConnectedAccountLaunch<Request>> {
  if (request.connectedAccounts?.some(selection => selection.purpose === DROID_CHATGPT_PURPOSE)) {
    throw new PluginError({ code: 'droid_chatgpt_account_unsupported', retryable: false,
      message: 'Droid requires a Factory login or a provider API key; a ChatGPT account is not supported.' });
  }
  const selections = await Promise.all(DROID_CONNECTED_ACCOUNT_PURPOSES.map(async declaration => {
    const admitted = request.connectedAccounts?.find(selection => selection.purpose === declaration.purpose);
    const binding = admitted ?? await context.services.connectedAccounts.getBinding(declaration.purpose, { signal: context.signal });
    return binding ? { declaration, account: binding.account } : null;
  }));
  const selected = selections.filter(selection => selection !== null);
  if (!selected.length) return { request, dispose() {} };
  if (selected.length > 1 || request.providerBinding) throw new PluginError({ code: 'droid_connected_account_provider_conflict', message: 'Choose one Connected Account or Provider connection for Droid.' });
  const { declaration, account } = selected[0]!;
  if (!modelId?.trim() || modelId.trim() === 'default') {
    throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
      message: 'Choose an explicit model for the Droid Connected Account.',
      details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
        phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
  }
  const invalid = () => new PluginError({ code: 'droid_connected_account_materialization_invalid', message: 'Droid requires the selected account credentials and native endpoint.' });
  // Every declared purpose derives from DROID_NATIVE_KEY_PURPOSES, so a selection always has its native key row.
  const nativeKey = DROID_NATIVE_KEY_PURPOSES.find(row => row.purpose === declaration.purpose);
  if (!nativeKey) throw invalid();
  const baseKey = 'baseUrlEnvironmentKey' in nativeKey ? nativeKey.baseUrlEnvironmentKey : undefined;
  const materialized = await context.services.connectedAccounts.materialize(declaration.purpose, {
    kind: 'environment', keys: [nativeKey.environmentKey, ...(baseKey ? [baseKey] : [])],
  }, { signal: context.signal, expectedAccount: account });
  if (materialized.kind !== 'environment') throw invalid();
  const key = materialized.env[nativeKey.environmentKey];
  const baseUrl = baseKey ? materialized.env[baseKey] : 'baseUrl' in nativeKey ? nativeKey.baseUrl : undefined;
  if (!key?.trim() || !baseUrl) throw invalid();
  const secret = key;
  const settings = buildDroidModelSettings({ modelId, provider: nativeKey.provider, baseUrl, hasCredential: true, headers: {} });
  const directory = createSecureTempDirectorySync({ prefix: 'droid-connected-account' });
  try {
    const settingsPath = join(directory.path, 'settings.json');
    await writeAtomicTextFile({ path: settingsPath, contents: settings, mode: 0o600 });
    const values: Record<string, string> = { ...request.launchEnvironment?.values, [DROID_PROVIDER_SECRET_ENV]: secret };
    const unset = new Set(request.launchEnvironment?.unset ?? []);
    unset.delete(DROID_PROVIDER_SECRET_ENV);
    return { request: { ...request, launchEnvironment: { values, unset: [...unset] } },
      customModel: { model: { id: modelId, name: modelId },
        commandArgsSuffix: droidSettingsCommandArgs(settingsPath), catalogConfidence: 'account_unverified' }, dispose: directory.cleanup };
  } catch (error) {
    directory.cleanup();
    throw error;
  }
}

const unsupported = () => ({ supported: false, status: 'unsupported' as const, reason: 'hot_apply_unsupported', recovery: 'restart_resume' as const });

const droidStateSharingDescriptor = {
  nativeHome: { environmentKey: 'HOME', defaultRelativePath: '.' },
  providerSupportStatus: 'supported',
  config: { supported: false, modes: ['isolated'], entries: [], unavailableReason: 'not_implemented' },
  state: { supported: true, modes: ['isolated', 'shared'], entries: [{ path: '.factory/sessions', mode: 'linked', createIfMissing: 'directory', requiresRealDirectory: true }], sharedStatePrivacyRiskAcknowledgementRequired: true, symlinkUnavailableDegradePolicy: 'block_continuity' },
  authIsolation: { mode: 'process_env', secretEntries: [DROID_NATIVE_AUTH_ENV_KEY] },
} as const;

export const DROID_CONNECTED_ACCOUNT_LAUNCH = {
  stateSharingDescriptor: droidStateSharingDescriptor,
  switchContinuity: { continuityMode: 'restart_shared_state_required', supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'] },
  continuity: {
    generationApplicationScope: 'per_session_runtime',
    runtimeAuthAdapter: {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => unsupported(),
      canHotApply: unsupported,
      hotApply: async () => ({ ...unsupported(), applied: false }),
      probeQuota: async () => ({ supported: false, status: 'unsupported', reason: 'runtime_quota_probe_unsupported' }),
      refreshActiveProfile: async () => unsupported(),
    },
    async verifyResumeReachable({ vendorResumeId, sessionFiles }) {
      if (!vendorResumeId) return { ok: false, reason: 'droid_native_resume_id_missing' };
      const candidate = await sessionFiles.findDeclaredCandidate({
        matchesCandidate: ({ nativeSessionId, fileName }) => nativeSessionId === vendorResumeId || fileName === `${vendorResumeId}.jsonl`,
      });
      return candidate.found ? { ok: true } : { ok: false, reason: 'droid_native_session_not_found' };
    },
  },
} satisfies AgentConnectedAccountLaunchContributionV1;
