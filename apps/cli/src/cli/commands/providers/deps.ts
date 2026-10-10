import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { DaemonProviderConnectionMutationRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { AccountSettings } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  resolveProviderContributionRegistryView,
} from '@/providers/registry';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { createAuthoritativeProviderSnapshotReader } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import type { ProviderSavedModelsRpcResult } from '@/providers/probe/rpc';
import { resolveCliFeatureDecision, resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
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

import { ProviderCliError, type ProviderCliDependencies, type ProviderCliModelRow } from './types';
import { routeProviderCliActions } from './actionDependencies';

const MAX_ADVANCED_JSON_BYTES = 64 * 1024;

export function unwrapProviderSavedModelsRpcResult(
  result: ProviderSavedModelsRpcResult,
): readonly ProviderCliModelRow[] {
  if (result.status === 'error') {
    throw new ProviderCliError(
      result.error.code,
      `Provider catalog failed: ${result.error.code}`,
      result.error,
    );
  }
  return result.models;
}

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

export function createProviderCliModelManagementServices(
  input: Omit<Parameters<typeof createRuntimeProviderModelManagementServices>[0], 'getAccountSettingsSnapshot'>
    & Readonly<{ initialSnapshot: ActiveAccountSettingsSnapshot }>,
): ReturnType<typeof createRuntimeProviderModelManagementServices> {
  const { initialSnapshot, ...runtimeInput } = input;
  return createRuntimeProviderModelManagementServices({
    ...runtimeInput,
    getAccountSettingsSnapshot: createAuthoritativeProviderSnapshotReader({
      initial: initialSnapshot,
      mode: 'live',
      readCurrent: getActiveAccountSettingsSnapshot,
    }),
  });
}

export async function resolveProviderCliDependencies(requestOptions: Readonly<{ signal?: AbortSignal }> = {}): Promise<ProviderCliDependencies> {
  const providersFeature = await resolveCliFeatureDecisionForServer({
    featureId: 'providers',
    env: process.env,
    serverUrl: configuration.serverUrl,
  });
  if (providersFeature.decision.state !== 'enabled') {
    throw new ProviderCliError('provider_feature_disabled', 'Providers are disabled by server policy');
  }
  const credentials = await readStoredCredentials();
  if (!credentials) throw new ProviderCliError('authentication_required', 'Sign in before managing providers');
  const modelManagementDecision = resolveCliFeatureDecision({
    featureId: 'providers.localModelManagement',
    env: process.env,
    ...(providersFeature.serverSnapshot ? { serverSnapshot: providersFeature.serverSnapshot } : {}),
  });
  const loadProviderCliSnapshot = async () => {
    const [accountContext, machine, registryLease] = await Promise.all([
      bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false }),
      ensureMachineIdForCredentials(credentials),
      acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: configuration.happyHomeDir }),
    ]);
    try {
      if (typeof registryLease.registry.generation !== 'number') {
        throw new ProviderCliError(
          'provider_contribution_unavailable',
          'The active Provider registry has no generation identity',
        );
      }
      const activeSnapshot = readProviderCliActiveSnapshot(accountContext);
      return {
        accountSettings: accountContext.settings as Readonly<Record<string, unknown>>,
        machineId: machine.machineId,
        registry: resolveProviderContributionRegistryView(
          registryLease.registry.contributes,
          registryLease.registry.generation,
          registryLease.registry.readPluginOccurrenceId,
        ),
        activeSnapshot,
      };
    } finally {
      await registryLease.release();
    }
  };
  const loadSnapshot: ProviderCliDependencies['loadSnapshot'] = async () => {
    const { activeSnapshot: _activeSnapshot, ...snapshot } = await loadProviderCliSnapshot();
    observedMachineId = snapshot.machineId;
    return snapshot;
  };
  let observedMachineId: string | undefined;
  let runtimeServices: ReturnType<typeof createRuntimeProviderModelManagementServices> | null = null;
  const resolveRuntimeServices = async () => {
    const snapshot = await loadProviderCliSnapshot();
    const connectionService = await resolveConnectionServices();
    runtimeServices ??= createProviderCliModelManagementServices({
      machineId: snapshot.machineId,
      initialSnapshot: snapshot.activeSnapshot,
      happyHomeDir: configuration.happyHomeDir,
      featureGate: {
        isEnabled: (featureId) => (featureId === 'providers'
          ? providersFeature.decision
          : modelManagementDecision).state === 'enabled',
      },
      modelSettingsMutation: connectionService.mutateModelSettings,
    });
    return runtimeServices;
  };
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
      featureGate: { isEnabled: () => providersFeature.decision.state === 'enabled' },
      runtimeSummary: async (input) => (await resolveRuntimeServices()).summary(input),
      refreshOnEnable: async (input) => (await resolveRuntimeServices()).probe(input),
    });
    return connectionRuntimeServices.service;
  };
  const deps: ProviderCliDependencies = {
    assertProvidersFeatureEnabled: () => {
      if (providersFeature.decision.state !== 'enabled') {
        throw new ProviderCliError('provider_feature_disabled', 'Providers are disabled by server policy');
      }
    },
    connections: {
      describe: async (input) => (await resolveConnectionServices()).describe(input),
      previewCreateContribution: async (input) => (await resolveConnectionServices()).previewCreateContribution(input),
      create: async (input) => (await resolveConnectionServices()).create(input),
      update: async (input) => (await resolveConnectionServices()).update(input),
      setEndpointOverride: async (input) => (await resolveConnectionServices()).setEndpointOverride(input),
      setEnabled: async (input) => (await resolveConnectionServices()).setEnabled(input),
      bindSecret: async (input) => (await resolveConnectionServices()).bindSecret(input),
      delete: async (input) => (await resolveConnectionServices()).delete(input),
    },
    loadSnapshot,
    allocateConnectionId: () => `pc_${randomUUID()}`,
    probe: async (input) => (await resolveRuntimeServices()).probe(input),
    models: async (input) => {
      const result = await (await resolveRuntimeServices()).models(input);
      return unwrapProviderSavedModelsRpcResult(result);
    },
    loadModel: async (input) => (await resolveRuntimeServices()).loadModel(input),
    mutateModelSettings: async (input) => (await resolveRuntimeServices()).mutateModelSettings(input),
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
    if (preparedSavedSecret && !machineId) throw new ProviderCliError('provider_machine_mismatch', 'Load the exact local machine before preparing a credential');
    // Only prompted material retains this live invocation. Ordinary reference
    // writes keep the canonical CLI's deferred approval behavior unchanged.
    const invocationSignal = options?.signal ?? requestOptions.signal;
    const signal = preparedSavedSecret ? invocationSignal ?? new AbortController().signal : invocationSignal;
    const executor = createCliActionExecutorFromCredentials({ credentials,
      ...(preparedSavedSecret && machineId ? {
        machineId,
        providerPreparedSavedSecret: preparedSavedSecret,
        hostActionApprovalLifetime: { actionId, signal: signal! },
        machineActionDirectTargetTransport: {
          machineId,
          invoke: async (method, request, invocation) => {
            invocation?.signal?.throwIfAborted();
            if (method !== RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE) {
              throw new ProviderCliError('unsupported_action', 'Prepared Provider credentials belong only to their connection mutation');
            }
            const operand = DaemonProviderConnectionMutationRequestV1Schema.parse(request);
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
