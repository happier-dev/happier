import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { DaemonProviderConnectionMutationRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isProviderActionMachineRequiredV1, parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readStoredCredentials } from '@/persistence';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import {
  bootstrapAccountSettingsContext,
  type AccountSettingsContext,
} from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import {
  getActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import { ProviderCliError, type ProviderCliDependencies } from './types';
import { routeProviderCliActions } from './actionDependencies';

const MAX_ADVANCED_JSON_BYTES = 64 * 1024;

export function readProviderCliActiveSnapshot(
  accountContext: AccountSettingsContext,
): ActiveAccountSettingsSnapshot {
  const active = getActiveAccountSettingsSnapshot();
  if (
    !active?.scopeKey
    || active.source !== accountContext.source
    || active.settings !== accountContext.settings
    || active.settingsVersion !== accountContext.settingsVersion
    || active.loadedAtMs !== accountContext.loadedAtMs
    || active.settingsSecretsReadKeys !== accountContext.settingsSecretsReadKeys
  ) {
    throw new ProviderCliError(
      'provider_settings_invalid',
      'The active account settings changed while Provider dependencies were loading',
    );
  }
  return active;
}

export async function resolveProviderCliDependencies(requestOptions: Readonly<{ signal?: AbortSignal }> = {}): Promise<ProviderCliDependencies> {
  const providersFeature = await resolveCliFeatureDecisionForServer({
    featureId: 'providers',
    env: process.env,
    serverUrl: resolveServerHttpBaseUrl(),
  });
  if (providersFeature.decision.state !== 'enabled') {
    throw new ProviderCliError('provider_feature_disabled', 'Providers are disabled by server policy');
  }
  const credentials = await readStoredCredentials();
  if (!credentials) throw new ProviderCliError('authentication_required', 'Sign in before managing providers');
  const loadProviderCliSnapshot = async () => {
    const [accountContext, machine, declarations] = await Promise.all([
      bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false }),
      ensureMachineIdForCredentials(credentials),
      resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir }),
    ]);
    const activeSnapshot = readProviderCliActiveSnapshot(accountContext);
    return {
      accountSettings: accountContext.settings as Readonly<Record<string, unknown>>,
      machineId: machine.machineId,
      // Friendly CLI authoring consumes admitted declarations, never an
      // executable registry fabricated in this standalone process.
      registry: { providersByContributionKey: declarations.providersByContributionKey },
      activeSnapshot,
    };
  };
  const loadSnapshot: ProviderCliDependencies['loadSnapshot'] = async () => {
    const { activeSnapshot: _activeSnapshot, ...snapshot } = await loadProviderCliSnapshot();
    observedMachineId = snapshot.machineId;
    return snapshot;
  };
  let observedMachineId: string | undefined;
  let connectionRuntimeServices: ReturnType<typeof createRuntimeProviderConnectionServices> | null = null;
  const resolveConnectionServices = async (expectedMachineId?: string) => {
    const snapshot = await loadProviderCliSnapshot();
    if (expectedMachineId && snapshot.machineId !== expectedMachineId) {
      throw new ProviderCliError('provider_machine_mismatch', 'The captured local Provider machine is no longer current');
    }
    connectionRuntimeServices ??= createRuntimeProviderConnectionServices({
      machineId: snapshot.machineId,
      credentials,
      happyHomeDir: configuration.happyHomeDir,
      resolveRegistry: async () => (await loadProviderCliSnapshot()).registry,
      featureGate: { isEnabled: () => providersFeature.decision.state === 'enabled' },
      // This private preparation owner can write the approved static binding,
      // but only the daemon can attest executable status in a standalone CLI.
      runtimeSummary: async () => ({ status: 'error', error: createProviderErrorV1('provider_machine_unavailable', {
        machineId: snapshot.machineId,
      }) }),
    });
    return connectionRuntimeServices.service;
  };
  const deps: Parameters<typeof routeProviderCliActions>[0] = {
    assertProvidersFeatureEnabled: () => {
      if (providersFeature.decision.state !== 'enabled') {
        throw new ProviderCliError('provider_feature_disabled', 'Providers are disabled by server policy');
      }
    },
    loadSnapshot,
    allocateConnectionId: () => `pc_${randomUUID()}`,
    readJsonFile: async (path) => {
      const data = await readFile(path);
      if (data.byteLength > MAX_ADVANCED_JSON_BYTES) {
        throw new ProviderCliError('custom_provider_json_too_large', 'Custom provider JSON exceeds 64 KiB');
      }
      try { return JSON.parse(data.toString('utf8')) as unknown; } catch {
        throw new ProviderCliError('custom_provider_json_invalid', 'Custom provider JSON is malformed');
      }
    },
    prompt: promptInput,
    promptSecret: promptSecretInput,
    createSavedSecret: async ({ name, value }) => {
      const id = `secret_${randomUUID()}`;
      const now = Date.now();
      const record = SavedSecretSchema.parse({
        id,
        name,
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value },
        createdAt: now,
        updatedAt: now,
      });
      return { id, record };
    },
  };
  return routeProviderCliActions(deps, async (actionId, input, options) => {
    const preparedSavedSecret = options?.preparedSavedSecret;
    const machineId = observedMachineId;
    const machineRequired = isProviderActionMachineRequiredV1(parseProviderActionRequestV1(actionId, input));
    if (preparedSavedSecret && machineRequired && !machineId) {
      throw new ProviderCliError('provider_machine_mismatch', 'Load the exact local machine before preparing a machine credential');
    }
    // Only prompted material retains this live invocation. Ordinary reference
    // writes keep the canonical CLI's deferred approval behavior unchanged.
    const invocationSignal = options?.signal ?? requestOptions.signal;
    const signal = preparedSavedSecret ? invocationSignal ?? new AbortController().signal : invocationSignal;
    const executor = createCliActionExecutorFromCredentials({ credentials,
      ...(preparedSavedSecret ? {
        providerPreparedSavedSecret: preparedSavedSecret,
        hostActionApprovalLifetime: { actionId, signal: signal! },
      } : {}),
      ...(preparedSavedSecret && machineRequired && machineId ? {
        machineId,
        machineActionDirectTargetTransport: {
          machineId,
          invoke: async (method, request, invocation) => {
            invocation?.signal?.throwIfAborted();
            if (method !== RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE) {
              throw new ProviderCliError('unsupported_action', 'Prepared Provider credentials belong only to their connection mutation');
            }
            const operand = DaemonProviderConnectionMutationRequestV1Schema.parse(request);
            if (operand.action !== 'createContribution' && operand.action !== 'bindSecret') {
              throw new ProviderCliError('unsupported_action', 'Prepared Provider credentials belong only to connection creation or credential binding');
            }
            if (operand.machineId !== machineId || observedMachineId !== machineId) {
              throw new ProviderCliError('provider_machine_mismatch', 'The prepared credential belongs to the captured local machine');
            }
            await resolveConnectionServices(machineId);
            return connectionRuntimeServices!.mutateConnection(operand, preparedSavedSecret);
          },
        },
      } : {}),
    });
    return executor.execute(actionId, input, { surface: 'cli', actionRequestId: randomUUID(), ...(signal ? { signal } : {}) });
  });
}
