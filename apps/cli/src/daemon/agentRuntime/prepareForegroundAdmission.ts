import { join } from 'node:path';

import {
  createProviderErrorV1,
  registerSensitiveDiagnosticValues,
  type ProviderErrorV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { prepareDirectProviderLaunch } from '@/providers/lifecycle/prepareDirectLaunch';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import {
  ForegroundProfileSecretRecoveryRequiredError,
  readForegroundProfileRequiredSecretNamesMissingBinding,
  resolveForegroundProfileSavedSecretEnvironment,
} from './resolveForegroundProfileSavedSecretEnvironment';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import {
  HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
  serializeProviderBindingLaunchHandoffForEnv,
} from '@/plugins/runtime/providerBindings/handoff';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { prepareAgentRuntimeSessionBridgeForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { logger } from '@/ui/logger';

import type {
  ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ForegroundAgentRuntimeAdmissionResponseV1,
} from './foregroundAdmissionContract';
import type { PreparedForegroundAgentRuntimeAdmission } from './foregroundAdmission';

function refusal(
  error: ProviderErrorV1,
): Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }> {
  return { ok: false, error };
}

export async function prepareForegroundAgentRuntimeAdmission(
  request: ForegroundAgentRuntimeAdmissionOwnerRequestV1,
): Promise<
  | Readonly<{ ok: true; prepared: PreparedForegroundAgentRuntimeAdmission }>
  | Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }>
> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: configuration.happyHomeDir,
  });
  let transferred = false;
  let cleanupPromise: Promise<void> | null = null;
  let providerCleanup: (() => void | Promise<void>) | null = null;
  let profileRedactionCleanup: (() => void) | null = null;
  let tokenCleanup: (() => Promise<void>) | null = null;
  const cleanup = async () => {
    if (cleanupPromise) return await cleanupPromise;
    cleanupPromise = (async () => {
      let firstError: unknown = null;
      for (const release of [
        providerCleanup,
        profileRedactionCleanup,
        tokenCleanup,
        lease.release,
      ]) {
        if (!release) continue;
        try {
          await release();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    })();
    await cleanupPromise;
  };

  try {
    const bridge = await prepareAgentRuntimeSessionBridgeForLease({
      target: request.backendTarget,
      lease,
    });
    if (
      !bridge
      || bridge.authorization.descriptor.agentId !== request.agentId
      || bridge.authorization.descriptor.backendId
        !== request.backendTarget.backendId
    ) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        request.selection
          ? {
              connectionId:
                request.selection.ref.providerConnectionId ?? undefined,
              machineId: request.machineId,
            }
          : { machineId: request.machineId },
      ));
    }
    tokenCleanup = bridge.cleanupTokenFile;
    const registration = lease.registry.agentRuntimesByAgentId.get(
      request.agentId,
    );
    if (
      !registration?.hasPrimaryRuntime
      || registration.pluginId !== bridge.authorization.descriptor.pluginId
      || registration.generation !== bridge.authorization.descriptor.generation
      || !registration.isCurrent()
    ) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        { machineId: request.machineId },
      ));
    }
    const requirements = readLeasedAgentProviderRequirements({
      lease,
      agentId: request.agentId,
    });
    const readExactProfileSnapshot = () => {
      if (!request.profileId) return null;
      const settingsSnapshot = getActiveAccountSettingsSnapshot();
      if (
        !settingsSnapshot
        || typeof settingsSnapshot.scopeKey !== 'string'
        || settingsSnapshot.scopeKey.length === 0
        || settingsSnapshot.scopeKey !== request.accountSettingsScopeKey
        || settingsSnapshot.settingsVersion !== request.accountSettingsVersion
      ) {
        return null;
      }
      const profile = readProfilesFromAccountSettings(
        settingsSnapshot.settings,
      ).visibleProfiles.find(
        (candidate) => candidate.id === request.profileId,
      );
      return profile
        ? Object.freeze({ settingsSnapshot, profile })
        : null;
    };
    const initialExactProfileSnapshot = readExactProfileSnapshot();
    if (request.profileId && !initialExactProfileSnapshot) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        {
          machineId: request.machineId,
          sourceProfileId: request.profileId,
        },
      ));
    }

    transferred = true;
    return {
      ok: true,
      prepared: {
        authorization: bridge.authorization,
        reservedEnvironmentVariableNames:
          requirements?.authIsolation.ownedEnvKeys ?? [],
        profileSecretRequirementNamesMissingBinding:
          initialExactProfileSnapshot
            ? readForegroundProfileRequiredSecretNamesMissingBinding({
                profile: initialExactProfileSnapshot.profile,
                accountSettings:
                  initialExactProfileSnapshot.settingsSnapshot.settings,
              })
            : Object.freeze([]),
        retirementSignal: registration.retirementSignal,
        isCurrent: registration.isCurrent,
        claim: async ({
          foregroundSatisfiedProfileSecretRequirementNames,
        }) => {
          try {
            let providerEnvironment: Readonly<Record<string, string>> =
              Object.freeze({});
            let providerUnsetEnvironmentVariableNames: readonly string[] =
              Object.freeze([]);
            if (request.selection) {
              const featureEnabled = (
                await resolveCliFeatureDecisionForServer({
                  featureId: 'providers',
                  env: process.env,
                  serverUrl: configuration.serverUrl,
                  timeoutMs: 1_500,
                })
              ).decision.state === 'enabled';
              const direct = await prepareDirectProviderLaunch({
                selection: request.selection,
                backendTarget: request.backendTarget,
                machineId: request.machineId,
                agentId: request.agentId,
                sessionId: request.sessionId,
                previousBinding: request.previousBinding ?? null,
                confirmation: null,
                connectedServices: null,
                featureEnabled,
              }, {
                resolvePrerequisites: async (providerBindingContext) => {
                  const result = await resolveSpawnChildEnvironment({
                    happyHomeDir: configuration.happyHomeDir,
                    pluginRuntimeRegistry: lease.registry,
                    options: {
                      directory: request.directory,
                      backendTarget: request.backendTarget,
                    },
                    profileEnvironmentVariables: {},
                    daemonSpawnHooks: null,
                    processEnv: process.env,
                    logDebug: (message) => logger.debug(message),
                    logInfo: (message) => logger.info(message),
                    logWarn: (message) => logger.warn(message),
                    connectedServiceAuth: null,
                    providerBindingContext: {
                      v: 1,
                      ...providerBindingContext,
                    },
                    providerBindingPrerequisitesOnly: true,
                  });
                  return result.ok
                    ? {
                        ok: true as const,
                        cleanupOnFailure: result.cleanupOnFailure,
                        cleanupOnExit: result.cleanupOnExit,
                      }
                    : {
                        ok: false as const,
                        error: createProviderErrorV1(
                          'provider_agent_runtime_unsupported',
                          {
                            connectionId:
                              providerBindingContext.connectionId,
                            machineId: request.machineId,
                          },
                        ),
                        cleanupOnFailure: result.cleanupOnFailure,
                        cleanupOnExit: result.cleanupOnExit,
                      };
                },
                createAuthorizationAttempt: async ({
                  selection,
                  machineId,
                  agentTargetKey,
                  agentId,
                }) => createRuntimeProviderSpawnAuthorizationAttempt({
                  selection,
                  machineId,
                  agentTargetKey,
                  agentId,
                  lease,
                  getAccountSettingsSnapshot:
                    getActiveAccountSettingsSnapshot,
                  subscribeAccountSettingsSnapshot: (listener) =>
                    subscribeActiveAccountSettingsSnapshot(
                      () => listener(),
                    ),
                  runtimeStateStore: createProviderRuntimeStateStore({
                    happyHomeDir: configuration.happyHomeDir,
                    machineId,
                  }),
                  materializationBaseDir: join(
                    configuration.happyHomeDir,
                    'providers',
                    'materialized',
                  ),
                  sessionId: request.sessionId,
                }),
              });
              if (!direct.ok) {
                if (
                  'kind' in direct
                  && direct.kind === 'managed_provider_requires_daemon'
                ) {
                  return {
                    ok: false as const,
                    error: createProviderErrorV1(
                      'provider_agent_runtime_unsupported',
                      {
                        connectionId:
                          request.selection.ref.providerConnectionId
                          ?? undefined,
                        machineId: request.machineId,
                      },
                    ),
                  };
                }
                return { ok: false as const, error: direct.error };
              }
              if (direct.kind !== 'provider') {
                return {
                  ok: false as const,
                  error: createProviderErrorV1(
                    'provider_agent_runtime_unsupported',
                    {
                      connectionId:
                        request.selection.ref.providerConnectionId
                        ?? undefined,
                      machineId: request.machineId,
                    },
                  ),
                };
              }
              providerCleanup = direct.cleanupOnExit;
              const current = await direct.revalidateBeforeCommit();
              if (!current.ok) {
                return { ok: false as const, error: current.error };
              }
              providerEnvironment = Object.freeze({
                ...direct.environment,
                [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                  serializeProviderBindingLaunchHandoffForEnv(
                    direct.launchMaterialization,
                    direct.bindingMetadata,
                  ),
              });
              providerUnsetEnvironmentVariableNames = direct.unsetEnvKeys;
            }

            let savedProfileEnvironment: Readonly<Record<string, string>> =
              Object.freeze({});
            let sensitiveEnvironmentVariableNames: readonly string[] =
              Object.freeze([]);
            if (request.profileId) {
              const exactProfileSnapshot = readExactProfileSnapshot();
              if (!exactProfileSnapshot) {
                return {
                  ok: false as const,
                  error: createProviderErrorV1(
                    'provider_authorization_changed',
                    {
                      connectionId:
                        request.selection?.ref.providerConnectionId
                        ?? undefined,
                      machineId: request.machineId,
                      sourceProfileId: request.profileId,
                    },
                  ),
                };
              }
              savedProfileEnvironment =
                resolveForegroundProfileSavedSecretEnvironment({
                  profile: exactProfileSnapshot.profile,
                  accountSettings:
                    exactProfileSnapshot.settingsSnapshot.settings,
                  settingsSecretsReadKeys:
                    exactProfileSnapshot.settingsSnapshot
                      .settingsSecretsReadKeys,
                  foregroundSatisfiedSecretRequirementNames:
                    foregroundSatisfiedProfileSecretRequirementNames,
                });
              profileRedactionCleanup =
                registerSensitiveDiagnosticValues(
                  Object.values(savedProfileEnvironment),
                ).close;
              sensitiveEnvironmentVariableNames = Object.freeze([
                ...new Set([
                  ...Object.keys(savedProfileEnvironment),
                  ...foregroundSatisfiedProfileSecretRequirementNames,
                ]),
              ]);
            }

            return {
              ok: true as const,
              environment: Object.freeze({
                ...bridge.childEnv,
                ...savedProfileEnvironment,
                ...providerEnvironment,
              }),
              unsetEnvironmentVariableNames:
                providerUnsetEnvironmentVariableNames,
              sensitiveEnvironmentVariableNames,
            };
          } catch (error) {
            if (
              error
              instanceof ForegroundProfileSecretRecoveryRequiredError
            ) {
              return {
                ok: false as const,
                error: createProviderErrorV1(
                  'provider_agent_runtime_unsupported',
                  {
                    connectionId:
                      request.selection?.ref.providerConnectionId
                      ?? undefined,
                    machineId: request.machineId,
                    sourceProfileId: request.profileId,
                  },
                ),
                profileSecretRecovery: Object.freeze({
                  requirementNames: error.requirementNames,
                }),
              };
            }
            return {
              ok: false as const,
              error: createProviderErrorV1(
                'provider_agent_runtime_unsupported',
                {
                  connectionId:
                    request.selection?.ref.providerConnectionId
                    ?? undefined,
                  machineId: request.machineId,
                },
              ),
            };
          }
        },
        cleanup,
      },
    };
  } catch {
    return refusal(createProviderErrorV1(
      'provider_agent_runtime_unsupported',
      {
        connectionId:
          request.selection?.ref.providerConnectionId ?? undefined,
        machineId: request.machineId,
      },
    ));
  } finally {
    if (!transferred) await cleanup().catch(() => undefined);
  }
}
