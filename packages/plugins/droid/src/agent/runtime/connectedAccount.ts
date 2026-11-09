import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type { AgentConnectedAccountLaunchContributionV1, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';

import { buildDroidModelSettings, DROID_PROVIDER_SECRET_ENV } from '../providerBinding/settings.js';

export const DROID_CHATGPT_PURPOSE = 'openai-codex';
export const DROID_CHATGPT_SERVICE = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'openai-codex' });
const REQUEST_AUTH = Object.freeze({ kind: 'httpHeaders' as const, origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'] });

type LaunchRequest = Pick<AgentSessionOpenRequest, 'configuration' | 'providerBinding' | 'launchEnvironment'>;
export type DroidConnectedAccountLaunch<Request extends LaunchRequest> = Readonly<{
  request: Request;
  customModel?: Readonly<{ model: Readonly<{ id: string; name: string }>; settingsPath: string }>;
  dispose(): void;
}>;

export async function prepareDroidConnectedAccount<Request extends LaunchRequest>(
  request: Request,
  context: Readonly<{ services: { connectedAccounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> }; signal?: AbortSignal }>,
): Promise<DroidConnectedAccountLaunch<Request>> {
  const binding = await context.services.connectedAccounts.getBinding(DROID_CHATGPT_PURPOSE, { signal: context.signal });
  if (!binding) return { request, dispose() {} };
  if (request.providerBinding) throw new PluginError({ code: 'droid_connected_account_provider_conflict', message: 'Choose either a Droid Provider connection or a ChatGPT Connected Account.' });
  const model = request.configuration?.model;
  if (!model?.value?.trim()) {
    throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
      message: 'Choose an explicit model for the Droid ChatGPT Connected Account.',
      details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
        phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
  }
  const materialized = await context.services.connectedAccounts.materialize(DROID_CHATGPT_PURPOSE, REQUEST_AUTH, { signal: context.signal, expectedAccount: binding.account });
  const invalid = () => new PluginError({ code: 'droid_connected_account_materialization_invalid', message: 'Droid requires ChatGPT bearer access and account identity headers.' });
  if (materialized.kind !== 'httpHeaders') throw invalid();
  const headers = new Headers(materialized.headers);
  const authorization = headers.get('authorization');
  const accountId = headers.get('chatgpt-account-id');
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim() || !accountId?.trim()) throw invalid();
  const settings = buildDroidModelSettings({ modelId: model.value, provider: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex',
    hasCredential: true, headers: { 'chatgpt-account-id': accountId, 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' } });
  const directory = createSecureTempDirectorySync({ prefix: 'droid-connected-account' });
  try {
    const settingsPath = join(directory.path, 'settings.json');
    await writeAtomicTextFile({ path: settingsPath, contents: settings, mode: 0o600 });
    const values: Record<string, string> = { ...request.launchEnvironment?.values, [DROID_PROVIDER_SECRET_ENV]: authorization.slice(7) };
    delete values.FACTORY_API_KEY;
    const unset = new Set(request.launchEnvironment?.unset ?? []);
    unset.delete(DROID_PROVIDER_SECRET_ENV);
    unset.add('FACTORY_API_KEY');
    return { request: { ...request, launchEnvironment: { values, unset: [...unset] } },
      customModel: { model: { id: model.value, name: model.value }, settingsPath }, dispose: directory.cleanup };
  } catch (error) {
    directory.cleanup();
    throw error;
  }
}

const unsupported = () => ({ supported: false, status: 'unsupported' as const, reason: 'hot_apply_unsupported', recovery: 'restart_resume' as const });

export const DROID_CONNECTED_ACCOUNT_LAUNCH = {
  switchContinuity: { continuityMode: 'restart_same_home', supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'] },
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
    async verifyResumeReachable() {
      // The native history reader scopes reads to its supplied home, while this
      // callback carries neither the actual launch home nor a Droid descriptor
      // proving it. A matching id in the daemon's default home is insufficient.
      return { ok: false, reason: 'droid_native_resume_home_unproven' };
    },
  },
} satisfies AgentConnectedAccountLaunchContributionV1;
