import { randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';

import {
  accountSettingsParse,
  CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
  CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
  ConnectedAccountAttemptResponseSchema,
  ConnectedAccountDaemonControlResponseSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  DaemonPluginStructuredMessageActionExecuteResponseSchema,
  DaemonPluginStructuredMessageResolveResponseSchema,
  DaemonPluginSettingsSetResponseSchema,
  ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
  FeaturesResponseSchema,
  openProviderAccountUsageSnapshotCiphertext,
  PluginSessionHookInstallResponseV1Schema,
  PluginSessionHookStatusResponseV1Schema,
  PluginSessionHookUninstallResponseV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  QualifiedConnectedAccountCredentialHealthPatchV4Schema,
  QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountGroupRefSchema,
  QualifiedConnectedAccountGroupResponseV4Schema,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountQuotaQueryV4Schema,
  QualifiedConnectedAccountQuotaResponseV4Schema,
  QualifiedConnectedAccountRefSchema,
  QualifiedConnectedAccountServiceRefSchema,
  QualifiedConnectedAccountSuccessV4Schema,
  ScmHostingRepositoryDescribePublishTargetsResponseSchema,
  ScmStatusSnapshotResponseSchema,
  encodeQualifiedConnectedAccountV4StructuredQueryValue,
  type ConnectedAccountAttemptResponse,
  type ConnectedAccountDaemonCommand,
  type ConnectedAccountDaemonControlCommand,
  type ConnectedAccountDaemonControlResponse,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  assertPackedAuthorCredentialSentinelsAbsent,
  formatPackedQualifiedConnectedAccountHttpFailure,
  loadPackedAuthorNaturalArtifacts,
  parseRunnerArgs,
  runVerticalA,
  type PackedAuthorCandidate,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  readEncryptedAccountSettingsV2OrEmpty,
  upsertEncryptedAccountSettingsV2,
} from '../testkit/accountSettings';
import { createTestAuth } from '../testkit/auth';
import { seedCliAuthForServer } from '../testkit/cliAuth';
import {
  callEncryptedMachineRpc,
  type MemoryRpcSchema,
} from '../testkit/memoryRpc';
import {
  decideAuthenticatedPluginInstallReview,
} from '../testkit/pluginPlatform/authenticatedInstallReview';
import { startServerLight, type StartedServer } from '../testkit/process/serverLight';
import { sanitizeDaemonEnvForSpawn } from '../testkit/daemon/daemon';
import { createRunDirs } from '../testkit/runDir';
import { createUserScopedSocketCollector, type SocketCollector } from '../testkit/socketClient';
import { waitFor } from '../testkit/timing';
import { waitForDaemonMachineIdFromCliSettings } from '../testkit/uiE2e/daemonMachineId';
import { renderPackedExternalAgentExecutable } from '../../scripts/plugin-platform/packed-external-agent-executable.mjs';

const PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE = Object.freeze({
  pluginId: 'acme.vertical-a',
  localId: 'novel-cloud',
});
const PACKED_NOVEL_SIMULATED_AUTHORIZATION_ORIGIN =
  'https://auth.novel.example';
const PACKED_GITHUB_CONNECTED_ACCOUNT_SERVICE =
  QualifiedConnectedAccountServiceRefSchema.parse({
    pluginId: 'happier.scm.hosting.github',
    localId: 'github-account',
  });
const PACKED_BITBUCKET_CONNECTED_ACCOUNT_SERVICE =
  QualifiedConnectedAccountServiceRefSchema.parse({
    pluginId: 'happier.scm.hosting.bitbucket',
    localId: 'bitbucket-account',
  });
const PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE =
  QualifiedConnectedAccountServiceRefSchema.parse({
    pluginId: 'happier.agent.claude',
    localId: 'claude-subscription',
  });

type ParseSchema<T> = Readonly<{
  parse(input: unknown): T;
}>;

function closeSocketCollector(collector: SocketCollector | null): void {
  collector?.close();
}

async function loadCandidate(argv: readonly string[]): Promise<PackedAuthorCandidate> {
  return await loadPackedAuthorNaturalArtifacts(argv);
}

export async function runPackedAuthorVerticalAWithTestServer(
  candidate: PackedAuthorCandidate,
  options: Readonly<{
    packedNovelQaHandoffRoot?: string;
  }> = {},
): Promise<Awaited<ReturnType<typeof runVerticalA>>> {
  const run = createRunDirs({ runLabel: `packed-author-${candidate.runId}` });
  const testDir = run.testDir('vertical-a');
  let server: StartedServer | null = null;
  let ui: SocketCollector | null = null;
  let packedHookInstallationId: string | null = null;
  let packedHookTargetPath: string | null = null;
  try {
    const databaseUrl = renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: resolve(
        testDir,
        'server-light-data',
        'happier-server-light.sqlite',
      ),
      platform: process.platform,
      sqlite: { connectionLimit: 4 },
    });
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        DATABASE_URL: databaseUrl,
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const serverBaseUrl = server.baseUrl;
    const secret = Uint8Array.from(randomBytes(32));
    const serverFeaturesResponse = await fetch(
      new URL('/v1/features', `${serverBaseUrl}/`),
    );
    if (!serverFeaturesResponse.ok) {
      throw new Error(
        `Packed author server feature discovery failed (${serverFeaturesResponse.status})`,
      );
    }
    const serverFeatures = FeaturesResponseSchema.parse(
      await serverFeaturesResponse.json(),
    );
    const qualifiedAccountsCapability =
      serverFeatures.capabilities.connectedServices.qualifiedAccounts ?? null;
    const ensureUi = async (happyHomeDir: string): Promise<Readonly<{
      machineId: string;
      ui: SocketCollector;
    }>> => {
      const machineId = await waitForDaemonMachineIdFromCliSettings({
        cliHomeDir: happyHomeDir,
      });
      if (!ui) {
        ui = createUserScopedSocketCollector(serverBaseUrl, auth.token, {
          captureEvents: false,
        });
        ui.connect();
        await waitFor(() => ui?.isConnected() === true, {
          timeoutMs: 20_000,
          context: 'packed author user-scoped socket',
        });
      }
      return { machineId, ui };
    };
    const result = await runVerticalA(candidate, {
      captureLayerResultsOnFailure: true,
      baseEnv: sanitizeDaemonEnvForSpawn(process.env),
      ...(options.packedNovelQaHandoffRoot
        ? {
            packedNovelQaHandoffRoot:
              resolve(options.packedNovelQaHandoffRoot),
          }
        : {}),
      prepareHome: async ({ happyHomeDir }) => {
        const packedAgentBinDir = resolve(happyHomeDir, 'packed-agent-bin');
        const packedAgentFixture =
          renderPackedExternalAgentExecutable(process.platform);
        const packedAgentExecutable = resolve(
          packedAgentBinDir,
          packedAgentFixture.fileName,
        );
        await mkdir(packedAgentBinDir, { recursive: true });
        await writeFile(
          packedAgentExecutable,
          packedAgentFixture.contents,
          'utf8',
        );
        if (process.platform !== 'win32') {
          await chmod(packedAgentExecutable, 0o755);
        }
        packedHookTargetPath = resolve(
          happyHomeDir,
          'packed-external-agent',
          'settings.json',
        );
        await mkdir(resolve(happyHomeDir, 'packed-external-agent'), {
          recursive: true,
        });
        await writeFile(packedHookTargetPath, '{}\n', 'utf8');
        await seedCliAuthForServer({
          cliHome: happyHomeDir,
          serverUrl: serverBaseUrl,
          token: auth.token,
          secret,
        });
        return {
          CI: '1',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
          HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
          HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'true',
          HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS: '5000',
          HAPPIER_CONNECTED_SERVICES_QUOTAS_TICK_MS: '5000',
          PATH: packedAgentBinDir,
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: `packed-author-${randomUUID()}`.slice(0, 64),
        };
      },
      decideInstallReview: async ({ happyHomeDir, pendingChangeId, review }) => {
        if (
          !review
          || typeof review !== 'object'
          || typeof review.pluginId !== 'string'
          || review.pluginId.trim().length === 0
          || typeof review.displayName !== 'string'
          || review.displayName.trim().length === 0
          || typeof review.version !== 'string'
          || review.version.trim().length === 0
          || !Array.isArray(review.optionalHostAccess)
        ) {
          throw new Error('Packed install review did not present exact user-reviewable plugin facts');
        }
        const optionalSelections = review.optionalHostAccess.map((access) => {
          if (!access || typeof access !== 'object' || typeof access.id !== 'string' || access.id.trim().length === 0) {
            throw new Error('Packed install review contained an invalid optional access identity');
          }
          return { accessId: access.id, selected: false };
        });
        return await decideAuthenticatedPluginInstallReview({
          cliHomeDir: happyHomeDir,
          serverUrl: serverBaseUrl,
          pendingChangeId,
          optionalSelections,
          confirmPresentUser: async () => true,
        });
      },
      probeRetainedCapabilities: async ({ phase, happyHomeDir, pluginId }) => {
        const connection = await ensureUi(happyHomeDir);
        const projection = await callEncryptedMachineRpc({
          ui: connection.ui,
          machineId: connection.machineId,
          method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
          req: { machineId: connection.machineId },
          secret,
          schema: DaemonContributionRegistryProjectionDescribeResponseSchema,
        });
        const expectedGeneration = String(projection.projection.generation);
        const structuredResolution = await callEncryptedMachineRpc({
          ui: connection.ui,
          machineId: connection.machineId,
          method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_RESOLVE,
          req: {
            machineId: connection.machineId,
            expectedGeneration,
            kind: 'acme.vertical-a/roundtrip-result.v1',
            payload: { message: phase === 'uninstalled' ? 'uninstalled' : 'installed' },
            facts: {},
          },
          secret,
          schema: DaemonPluginStructuredMessageResolveResponseSchema,
        });
        if (phase === 'uninstalled' || !structuredResolution.ok) {
          return { projection, structuredResolution };
        }
        const structuredAction = await callEncryptedMachineRpc({
          ui: connection.ui,
          machineId: connection.machineId,
          method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
          req: {
            machineId: connection.machineId,
            expectedGeneration,
            qualifiedActionId: `${pluginId}/roundtrip`,
            input: { operation: 'structured-message-action' },
            executionSurface: 'ui',
          },
          secret,
          schema: DaemonPluginStructuredMessageActionExecuteResponseSchema,
        });
        return { projection, structuredResolution, structuredAction };
      },
      probeConnectedAccounts: async ({
        phase,
        happyHomeDir,
        configuredOrigin,
        staleConfiguredOrigin,
        oauthAttemptId,
        oauthCallbackUrl,
        oauthState,
        deviceAttemptId,
        builtinAccountId,
      }) => {
        const connection = await ensureUi(happyHomeDir);
        const command = async (
          input: ConnectedAccountDaemonCommand,
        ): Promise<ConnectedAccountAttemptResponse> =>
          await callEncryptedMachineRpc({
            ui: connection.ui,
            machineId: connection.machineId,
            method: CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
            req: {
              v: 1,
              machineId: connection.machineId,
              command: input,
            },
            secret,
            schema: ConnectedAccountAttemptResponseSchema,
          });
        const control = async (
          input: ConnectedAccountDaemonControlCommand,
        ): Promise<ConnectedAccountDaemonControlResponse> =>
          await callEncryptedMachineRpc({
            ui: connection.ui,
            machineId: connection.machineId,
            method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
            req: {
              v: 1,
              machineId: connection.machineId,
              command: input,
            },
            secret,
            schema: ConnectedAccountDaemonControlResponseSchema,
          });
        const waitForAttemptStatus = async (
          attemptId: string,
          expectedStatus: string,
        ): Promise<ConnectedAccountAttemptResponse> => {
          let latest: ConnectedAccountAttemptResponse =
            Object.freeze({ status: 'starting', attemptId });
          for (let attempt = 0; attempt < 120; attempt += 1) {
            latest = await command({ operation: 'read', attemptId });
            if (latest.status === expectedStatus) return latest;
            if (latest.status !== 'starting') return latest;
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
          }
          return latest;
        };
        const accountRef = (accountId: string): QualifiedConnectedAccountRef =>
          QualifiedConnectedAccountRefSchema.parse({
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            accountId,
          });
        const accountA = accountRef('account-a');
        const accountB = accountRef('account-b');
        const deviceAccount = accountRef('device-account');
        const groupRef = QualifiedConnectedAccountGroupRefSchema.parse({
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          groupId: 'packed-fallback',
        });
        const structuredQuery = <T>(
          key: string,
          schema: Parameters<
            typeof encodeQualifiedConnectedAccountV4StructuredQueryValue<T>
          >[0],
          value: T,
        ): string => new URLSearchParams({
          [key]: encodeQualifiedConnectedAccountV4StructuredQueryValue(
            schema,
            value,
          ),
        }).toString();
        const requestV4 = async <T>(
          path: string,
          schema: ParseSchema<T>,
          init: RequestInit = {},
        ): Promise<T> => {
          const response = await fetch(new URL(path, `${serverBaseUrl}/`), {
            ...init,
            headers: {
              authorization: `Bearer ${auth.token}`,
              ...(init.body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
              ...init.headers,
            },
          });
          if (!response.ok) {
            throw new Error(
              formatPackedQualifiedConnectedAccountHttpFailure({
                method: init.method ?? 'GET',
                path,
                status: response.status,
              }),
            );
          }
          return schema.parse(await response.json());
        };
        const requestOptionalV4 = async <T>(
          path: string,
          schema: ParseSchema<T>,
        ): Promise<T | null> => {
          const response = await fetch(new URL(path, `${serverBaseUrl}/`), {
            headers: { authorization: `Bearer ${auth.token}` },
          });
          if (response.status === 404) return null;
          if (!response.ok) {
            throw new Error(
              formatPackedQualifiedConnectedAccountHttpFailure({
                method: 'GET',
                path,
                status: response.status,
              }),
            );
          }
          return schema.parse(await response.json());
        };
        const readCredential = async (ref: QualifiedConnectedAccountRef) =>
          await requestOptionalV4(
            `/v4/connect/qualified/credential?${structuredQuery(
              'ref',
              QualifiedConnectedAccountRefSchema,
              ref,
            )}`,
            QualifiedConnectedAccountCredentialSnapshotV4Schema,
          );
        const readQuota = async (ref: QualifiedConnectedAccountRef) =>
          await requestOptionalV4(
            `/v4/connect/qualified/quotas?${structuredQuery(
              'ref',
              QualifiedConnectedAccountRefSchema,
              ref,
            )}`,
            QualifiedConnectedAccountQuotaResponseV4Schema,
          );
        const readGroup = async () =>
          await requestOptionalV4(
            `/v4/connect/qualified/group?${structuredQuery(
              'group',
              QualifiedConnectedAccountGroupRefSchema,
              groupRef,
            )}`,
            QualifiedConnectedAccountGroupResponseV4Schema,
          );
        const listAccountsForService = async (
          service: Readonly<{ pluginId: string; localId: string }>,
        ) =>
          await requestV4(
            `/v4/connect/qualified/accounts?${structuredQuery(
              'service',
              QualifiedConnectedAccountServiceRefSchema,
              service,
            )}`,
            QualifiedConnectedAccountListResponseV4Schema,
          );
        const listAccounts = async () =>
          await listAccountsForService(PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE);
        const mutateQualifiedGroup = async (
          path: string,
          body: Readonly<Record<string, unknown>>,
        ) => {
          const response = await fetch(new URL(path, `${serverBaseUrl}/`), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${auth.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            throw new Error(
              formatPackedQualifiedConnectedAccountHttpFailure({
                method: 'POST',
                path,
                status: response.status,
              }),
            );
          }
          return QualifiedConnectedAccountGroupResponseV4Schema.parse(
            await response.json(),
          ).group;
        };
        const readDormancySnapshot = async () => {
          const [
            deviceCredential,
            groupResponse,
            accounts,
            accountSettings,
          ] = await Promise.all([
            readCredential(deviceAccount),
            readGroup(),
            listAccounts(),
            readEncryptedAccountSettingsV2OrEmpty({
              baseUrl: serverBaseUrl,
              token: auth.token,
              secret,
            }),
          ]);
          const profile = accounts.accounts.find(
            ({ ref }) => ref.accountId === deviceAccount.accountId,
          ) ?? null;
          const binding =
            accountSettings.settings.connectedAccountPurposeBindingsV1.bindings
              .find(({ purpose }) => (
                purpose.consumer.pluginId === 'acme.vertical-a'
                && purpose.consumer.localId === 'roundtrip'
                && purpose.purpose === 'packed-novel-account'
              )) ?? null;
          return {
            binding,
            group: groupResponse?.group ?? null,
            account: {
              accountId: deviceAccount.accountId,
              status: profile?.status ?? null,
              credentialPresent: deviceCredential !== null,
              configurationPresent:
                typeof deviceCredential?.configurationRevision === 'string',
            },
          };
        };
        if (phase === 'builtinMultimodeCleanup') {
          if (!builtinAccountId) {
            throw new Error(
              'Packed bundled Claude cleanup requires the connected account id',
            );
          }
          const account = QualifiedConnectedAccountRefSchema.parse({
            service: PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
            accountId: builtinAccountId,
          });
          const credentialBeforeRevoke = await readCredential(account);
          const revoked = await control({
            operation: 'revokeAccount',
            account,
            cleanupGroupReferences: true,
          });
          const [credentialAfterRevoke, accountsAfterRevoke] =
            await Promise.all([
              readCredential(account),
              listAccountsForService(PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE),
            ]);
          return {
            account,
            credentialBeforeRevoke,
            revoked,
            credentialAfterRevoke,
            accountAfterRevoke:
              accountsAfterRevoke.accounts.find(
                ({ ref }) => ref.accountId === account.accountId,
              ) ?? null,
          };
        }
        if (phase === 'builtinMultimode') {
          const descriptorBefore = await control({
            operation: 'describeService',
            service: PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
          });
          const beginSetupTokenStart = await command({
            operation: 'beginConnect',
            service: PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'setup-token',
          });
          const beginSetupToken =
            beginSetupTokenStart.status === 'starting'
              ? await waitForAttemptStatus(
                  beginSetupTokenStart.attemptId,
                  'awaitingManual',
                )
              : beginSetupTokenStart;
          const connected = beginSetupToken.attemptId
            ? await command({
                operation: 'submitManual',
                attemptId: beginSetupToken.attemptId,
                fields: { token: 'packed-claude-setup-token-initial' },
              })
            : null;
          if (connected?.status !== 'connected') {
            return {
              descriptorBefore,
              beginSetupTokenStart,
              beginSetupToken,
              connected,
              qualifiedAccountsCapability,
            };
          }
          const account = connected.account;
          const credentialAfterConnect = await readCredential(account);
          let profileAfterConnect =
            (await listAccountsForService(
              PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
            )).accounts.find(
              ({ ref }) => ref.accountId === account.accountId,
            ) ?? null;
          await waitFor(async () => {
            profileAfterConnect =
              (await listAccountsForService(
                PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
              )).accounts.find(
                ({ ref }) => ref.accountId === account.accountId,
              ) ?? null;
            return profileAfterConnect?.status === 'connected';
          }, {
            timeoutMs: 30_000,
            context: 'packed bundled Claude setup-token status',
          });
          const beginReconnectStart = await command({
            operation: 'beginReconnect',
            account,
            ...(credentialAfterConnect?.configurationRevision
              ? {
                  expectedConfigurationRevision:
                    credentialAfterConnect.configurationRevision,
                }
              : {}),
          });
          const beginReconnect =
            beginReconnectStart.status === 'starting'
              ? await waitForAttemptStatus(
                  beginReconnectStart.attemptId,
                  'awaitingManual',
                )
              : beginReconnectStart;
          const reconnected = beginReconnect.attemptId
            ? await command({
                operation: 'submitManual',
                attemptId: beginReconnect.attemptId,
                fields: {
                  token: 'packed-claude-setup-token-reconnected',
                },
              })
            : null;
          const credentialAfterReconnect = await readCredential(account);
          const profileAfterReconnect =
            (await listAccountsForService(
              PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
            )).accounts.find(
              ({ ref }) => ref.accountId === account.accountId,
            ) ?? null;
          const descriptorAfterReconnect = await control({
            operation: 'describeService',
            service: PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
          });
          const beginOAuthStart = await command({
            operation: 'beginConnect',
            service: PACKED_CLAUDE_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'oauth',
          });
          const beginOAuth =
            beginOAuthStart.status === 'starting'
              ? await waitForAttemptStatus(
                  beginOAuthStart.attemptId,
                  'awaitingOAuth',
                )
              : beginOAuthStart;
          const cancelOAuth = beginOAuth.attemptId
            ? await command({
                operation: 'cancel',
                attemptId: beginOAuth.attemptId,
              })
            : null;

          const currentAccountSettings =
            await readEncryptedAccountSettingsV2OrEmpty({
              baseUrl: serverBaseUrl,
              token: auth.token,
              secret,
            });
          const retainedBindings =
            currentAccountSettings.settings
              .connectedAccountPurposeBindingsV1.bindings.filter(
                ({ purpose }) => !(
                  purpose.consumer.pluginId === 'acme.vertical-a'
                  && purpose.consumer.localId === 'roundtrip'
                  && purpose.purpose === 'packed-claude-account'
                ),
              );
          await upsertEncryptedAccountSettingsV2({
            baseUrl: serverBaseUrl,
            token: auth.token,
            secret,
            expectedVersion: currentAccountSettings.settingsVersion,
            settings: accountSettingsParse({
              ...currentAccountSettings.settings,
              connectedAccountPurposeBindingsV1: {
                v: 1,
                bindings: [
                  ...retainedBindings,
                  {
                    purpose: {
                      consumer: {
                        pluginId: 'acme.vertical-a',
                        localId: 'roundtrip',
                      },
                      purpose: 'packed-claude-account',
                    },
                    target: {
                      kind: 'account',
                      account,
                    },
                  },
                ],
              },
            }),
          });
          return {
            descriptorBefore,
            beginSetupTokenStart,
            beginSetupToken,
            connected,
            credentialAfterConnect,
            profileAfterConnect,
            beginReconnectStart,
            beginReconnect,
            reconnected,
            credentialAfterReconnect,
            profileAfterReconnect,
            descriptorAfterReconnect,
            beginOAuthStart,
            beginOAuth,
            cancelOAuth,
            qualifiedAccountsCapability,
          };
        }
        if (phase === 'establishedOperations') {
          const [
            accountACredentialBefore,
            accountBCredentialBefore,
            deviceCredentialBefore,
          ] = await Promise.all([
            readCredential(accountA),
            readCredential(accountB),
            readCredential(deviceAccount),
          ]);
          if (
            !accountACredentialBefore
            || !accountBCredentialBefore
            || !deviceCredentialBefore
          ) {
            throw new Error(
              'Packed established operations require all durable account credentials',
            );
          }
          const githubDescription = await control({
            operation: 'describeService',
            service: PACKED_GITHUB_CONNECTED_ACCOUNT_SERVICE,
          });
          const bitbucketDescription = await control({
            operation: 'describeService',
            service: PACKED_BITBUCKET_CONNECTED_ACCOUNT_SERVICE,
          });

          const healthPatch =
            QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse({
              ref: accountA,
              expectedCredentialRevision:
                accountACredentialBefore.credentialRevision,
              expectedConfigurationRevision:
                accountACredentialBefore.configurationRevision,
              health: {
                v: 1,
                status: 'needs_reauth',
                reconnectRequired: true,
              },
            });
          const healthMutation = await requestV4(
            '/v4/connect/qualified/credential/health',
            QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
            {
              method: 'PATCH',
              body: JSON.stringify(healthPatch),
            },
          );
          const accountAImmediatelyAfterHealth = (await listAccounts())
            .accounts.find(({ ref }) => ref.accountId === accountA.accountId)
            ?? null;
          let accountAAfterScheduledStatus = accountAImmediatelyAfterHealth;
          await waitFor(async () => {
            accountAAfterScheduledStatus = (await listAccounts())
              .accounts.find(({ ref }) => ref.accountId === accountA.accountId)
              ?? null;
            return accountAAfterScheduledStatus?.status === 'connected';
          }, {
            timeoutMs: 30_000,
            context: 'packed scheduled Connected Account status recovery',
          });
          const accountACredentialAfterScheduledStatus =
            await readCredential(accountA);

          const deviceConfigurationBefore = await control({
            operation: 'readConfiguration',
            target: {
              kind: 'account',
              account: deviceAccount,
            },
          });
          if (
            deviceConfigurationBefore.status !== 'configuration'
            || typeof deviceConfigurationBefore.configuration.revision
              !== 'string'
          ) {
            throw new Error(
              'Packed device account requires durable account-scoped configuration',
            );
          }
          const deviceRefresh = await control({
            operation: 'replaceConfiguration',
            target: {
              kind: 'account',
              account: deviceAccount,
            },
            expectedRevision:
              deviceConfigurationBefore.configuration.revision,
            values: {
              'api-origin': configuredOrigin,
              workspace: 'packed-workspace-refreshed',
            },
            secretValues: {},
          });
          if (deviceRefresh.status !== 'configurationCommitted') {
            throw new Error(
              `Packed device account refresh was not committed: ${deviceRefresh.status}`,
            );
          }
          let deviceCredentialAfter = await readCredential(deviceAccount);
          await waitFor(async () => {
            deviceCredentialAfter = await readCredential(deviceAccount);
            return (
              deviceCredentialAfter?.credentialRevision
                !== deviceCredentialBefore.credentialRevision
              && deviceCredentialAfter?.configurationRevision
                === deviceRefresh.configuration.revision
            );
          }, {
            timeoutMs: 30_000,
            context: 'packed account-scoped configuration refresh durability',
          });
          const deviceConfigurationAfter = await control({
            operation: 'readConfiguration',
            target: {
              kind: 'account',
              account: deviceAccount,
            },
          });

          let initialQuota = await readQuota(accountB);
          await waitFor(async () => {
            initialQuota = await readQuota(accountB);
            return initialQuota !== null;
          }, {
            timeoutMs: 30_000,
            context: 'packed scheduled Connected Account initial quota',
          });
          if (!initialQuota) {
            throw new Error('Packed account B quota did not become durable');
          }
          if (initialQuota.content.t !== 'encrypted') {
            throw new Error(
              'Packed initial Qualified Connected Account quota must use encrypted content',
            );
          }
          const openedInitialQuota =
            openProviderAccountUsageSnapshotCiphertext({
              material: { type: 'legacy', secret },
              ciphertext: initialQuota.content.c,
            });
          const initialQuotaUsage =
            ProviderAccountUsageSnapshotV1Schema.parse(
              openedInitialQuota?.value,
            );
          const initialQuotaFetchedAt = initialQuota.metadata.fetchedAt;
          while (Date.now() <= initialQuotaFetchedAt) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 1));
          }
          const quotaRefreshQuery =
            QualifiedConnectedAccountQuotaQueryV4Schema.parse({
              ref: accountB,
            });
          const quotaRefreshRequested = await requestV4(
            '/v4/connect/qualified/quotas/refresh',
            QualifiedConnectedAccountSuccessV4Schema,
            {
              method: 'POST',
              body: JSON.stringify(quotaRefreshQuery),
            },
          );
          let refreshedQuota = initialQuota;
          await waitFor(async () => {
            const latest = await readQuota(accountB);
            if (!latest) return false;
            refreshedQuota = latest;
            return (
              latest.metadata.fetchedAt > initialQuotaFetchedAt
              && (
                latest.metadata.refreshRequestedAt === undefined
                || latest.metadata.refreshRequestedAt
                  <= latest.metadata.fetchedAt
              )
            );
          }, {
            timeoutMs: 30_000,
            context: 'packed explicit Connected Account quota refresh',
          });
          if (refreshedQuota.content.t !== 'encrypted') {
            throw new Error(
              'Packed Qualified Connected Account quota must use encrypted content',
            );
          }
          const openedQuota = openProviderAccountUsageSnapshotCiphertext({
            material: { type: 'legacy', secret },
            ciphertext: refreshedQuota.content.c,
          });
          const quotaUsage = ProviderAccountUsageSnapshotV1Schema.parse(
            openedQuota?.value,
          );

          const groupBeforeRevoke = await readGroup();
          const revoked = await control({
            operation: 'revokeAccount',
            account: accountA,
            cleanupGroupReferences: true,
          });
          const [
            accountACredentialAfterRevoke,
            accountAQuotaAfterRevoke,
            groupAfterRevoke,
            accountsAfterRevoke,
          ] = await Promise.all([
            readCredential(accountA),
            readQuota(accountA),
            readGroup(),
            listAccounts(),
          ]);
          const accountAProfileAfterRevoke =
            accountsAfterRevoke.accounts.find(
              ({ ref }) => ref.accountId === accountA.accountId,
            ) ?? null;
          const accountBProfileAfterRevoke =
            accountsAfterRevoke.accounts.find(
              ({ ref }) => ref.accountId === accountB.accountId,
            ) ?? null;
          return {
            bundledServiceDescriptions: {
              githubDescription,
              bitbucketDescription,
            },
            statusLifecycle: {
              healthMutation,
              accountAImmediatelyAfterHealth,
              accountAAfterScheduledStatus,
              accountACredentialBefore,
              accountACredentialAfterScheduledStatus,
            },
            refreshLifecycle: {
              deviceCredentialBefore,
              deviceConfigurationBefore,
              deviceRefresh,
              deviceCredentialAfter,
              deviceConfigurationAfter,
            },
            quotaLifecycle: {
              initialQuota,
              initialQuotaUsage,
              quotaRefreshRequested,
              refreshedQuota,
              quotaUsage,
            },
            revokeLifecycle: {
              groupBeforeRevoke,
              revoked,
              accountACredentialAfterRevoke,
              accountAQuotaAfterRevoke,
              accountAProfileAfterRevoke,
              accountBProfileAfterRevoke,
              groupAfterRevoke,
            },
            qualifiedAccountsCapability,
          };
        }
        if (phase === 'directDelete') {
          const [
            accountBCredentialBefore,
            groupBefore,
            accountsBefore,
          ] = await Promise.all([
            readCredential(accountB),
            readGroup(),
            listAccounts(),
          ]);
          if (!accountBCredentialBefore) {
            throw new Error(
              'Packed direct delete requires a durable account B credential',
            );
          }
          const deletion = await requestV4(
            `/v4/connect/qualified/credential?${new URLSearchParams({
              ref: encodeQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                accountB,
              ),
              expectedCredentialRevision:
                accountBCredentialBefore.credentialRevision,
              cleanupGroupReferences: 'true',
            }).toString()}`,
            QualifiedConnectedAccountSuccessV4Schema,
            { method: 'DELETE' },
          );
          const [
            accountBCredentialAfter,
            accountBQuotaAfter,
            groupAfter,
            accountsAfter,
          ] = await Promise.all([
            readCredential(accountB),
            readQuota(accountB),
            readGroup(),
            listAccounts(),
          ]);
          const accountBProfileBeforeDelete =
            accountsBefore.accounts.find(
              ({ ref }) => ref.accountId === accountB.accountId,
            ) ?? null;
          const accountBProfileAfterDelete =
            accountsAfter.accounts.find(
              ({ ref }) => ref.accountId === accountB.accountId,
            ) ?? null;
          return {
            directDeleteLifecycle: {
              accountBCredentialBefore,
              accountBProfileBeforeDelete,
              groupBefore,
              deletion,
              accountBCredentialAfter,
              accountBQuotaAfter,
              accountBProfileAfterDelete,
              groupAfter,
            },
            qualifiedAccountsCapability,
          };
        }
        if (
          phase === 'watchRematerialize'
          || phase === 'watchRestore'
        ) {
          const groupBefore = await readGroup();
          if (!groupBefore?.group) {
            throw new Error(
              'Packed watch rematerialization requires the durable fallback group',
            );
          }
          const group = await mutateQualifiedGroup(
            '/v4/connect/qualified/group/active-account',
            {
              group: groupRef,
              connectedAccountId:
                phase === 'watchRematerialize' ? 'account-a' : 'account-b',
              expectedGeneration: groupBefore.group.generation,
              expectedRuntimeStateRevision:
                groupBefore.group.runtimeStateRevision,
            },
          );
          if (phase === 'watchRematerialize') {
            const current = await readEncryptedAccountSettingsV2OrEmpty({
              baseUrl: serverBaseUrl,
              token: auth.token,
              secret,
            });
            await upsertEncryptedAccountSettingsV2({
              baseUrl: serverBaseUrl,
              token: auth.token,
              secret,
              expectedVersion: current.settingsVersion,
              settings: accountSettingsParse(current.settings),
            });
          }
          return { group };
        }
        if (phase === 'prepareDormancy') {
          const groupBefore = await readGroup();
          if (!groupBefore?.group || !(await readCredential(deviceAccount))) {
            throw new Error(
              'Packed dormancy preparation requires its durable group and device account',
            );
          }
          const withDevice = await mutateQualifiedGroup(
            '/v4/connect/qualified/group/members',
            {
              group: groupRef,
              connectedAccountId: deviceAccount.accountId,
              priority: 30,
              expectedRuntimeStateRevision:
                groupBefore.group.runtimeStateRevision,
            },
          );
          await mutateQualifiedGroup(
            '/v4/connect/qualified/group/active-account',
            {
              group: groupRef,
              connectedAccountId: deviceAccount.accountId,
              expectedGeneration: withDevice.generation,
              expectedRuntimeStateRevision:
                withDevice.runtimeStateRevision,
            },
          );
          return await readDormancySnapshot();
        }
        if (phase === 'dormant') {
          const snapshot = await readDormancySnapshot();
          const runtime = await command({
            operation: 'beginConnect',
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'manual',
          });
          return {
            ...snapshot,
            runtime: {
              status: runtime.status,
              ...('code' in runtime ? { code: runtime.code } : {}),
            },
          };
        }
        if (phase === 'reEnabled') {
          return await readDormancySnapshot();
        }
        if (phase === 'restarted') {
          if (
            !oauthAttemptId
            || !oauthCallbackUrl
            || !oauthState
            || !deviceAttemptId
          ) {
            throw new Error(
              'Packed Connected Account restart probe requires durable OAuth and device attempts',
            );
          }
          const completeOAuth = await command({
            operation: 'completeOAuth',
            attemptId: oauthAttemptId,
            completion: {
              code: 'outcome-unknown',
              callbackUrl: oauthCallbackUrl,
              state: oauthState,
            },
          });
          const reconcileOAuth = completeOAuth.attemptId
            ? await command({
                operation: 'reconcile',
                attemptId: completeOAuth.attemptId,
              })
            : null;
          const resumeDevice = await command({
            operation: 'resumeDevice',
            attemptId: deviceAttemptId,
          });
          const devicePolls: ConnectedAccountAttemptResponse[] = [];
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const poll = await command({
              operation: 'pollDevice',
              attemptId: deviceAttemptId,
            });
            devicePolls.push(poll);
            if (poll.status !== 'pending') break;
            await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
          }
          const deviceFinal = devicePolls.at(-1) ?? null;
          const deviceAccountConfiguration = deviceFinal?.status === 'connected'
            ? await control({
                operation: 'readConfiguration',
                target: {
                  kind: 'account',
                  account: deviceFinal.account,
                },
              })
            : null;
          return {
            completeOAuth,
            reconcileOAuth,
            resumeDevice,
            devicePolls,
            deviceFinal,
            deviceAccountConfiguration,
            qualifiedAccountsCapability,
          };
        }
        if (phase !== 'installed') {
          const begin = await command({
            operation: 'beginConnect',
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'manual',
          });
          if (phase === 'uninstalled' || !begin.attemptId) {
            return { begin, qualifiedAccountsCapability };
          }
          return {
            begin,
            qualifiedAccountsCapability,
            cancellation: await command({
              operation: 'cancel',
              attemptId: begin.attemptId,
            }),
          };
        }
        const currentAccountSettings =
          await readEncryptedAccountSettingsV2OrEmpty({
            baseUrl: serverBaseUrl,
            token: auth.token,
            secret,
          });
        await upsertEncryptedAccountSettingsV2({
          baseUrl: serverBaseUrl,
          token: auth.token,
          secret,
          expectedVersion: currentAccountSettings.settingsVersion,
          settings: accountSettingsParse({
            ...currentAccountSettings.settings,
            connectedAccountPurposeBindingsV1: {
              v: 1,
              bindings: [{
                purpose: {
                  consumer: {
                    pluginId: 'acme.vertical-a',
                    localId: 'roundtrip',
                  },
                  purpose: 'packed-novel-account',
                },
                target: {
                  kind: 'group',
                  service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
                  groupId: 'packed-fallback',
                },
              }, {
                purpose: {
                  consumer: {
                    pluginId: 'acme.vertical-a',
                    localId: 'forge',
                  },
                  purpose: 'authentication',
                },
                target: {
                  kind: 'group',
                  service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
                  groupId: 'packed-fallback',
                },
              }],
            },
          }),
        });
        const initialConfigurationAdmission = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'manual',
        });
        const configurationCommitted = await control({
          operation: 'replaceConfiguration',
          target: {
            kind: 'service',
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'manual',
          },
          expectedRevision: null,
          values: { 'api-origin': configuredOrigin },
          secretValues: {},
        });
        const configuredRevision =
          configurationCommitted.status === 'configurationCommitted'
            ? configurationCommitted.configuration.revision
            : null;
        if (typeof configuredRevision !== 'string') {
          return {
            initialConfigurationAdmission,
            configurationCommitted,
            qualifiedAccountsCapability,
          };
        }
        const beginStaleConfiguration = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'manual',
          expectedConfigurationRevision: configuredRevision,
        });
        const staleConfigurationCommitted = await control({
          operation: 'replaceConfiguration',
          target: {
            kind: 'service',
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'manual',
          },
          expectedRevision: configuredRevision,
          values: { 'api-origin': staleConfiguredOrigin },
          secretValues: {},
        });
        const staleRevision =
          staleConfigurationCommitted.status === 'configurationCommitted'
            ? staleConfigurationCommitted.configuration.revision
            : null;
        const staleConfigurationSubmit =
          typeof beginStaleConfiguration.attemptId === 'string'
            ? await command({
                operation: 'submitManual',
                attemptId: beginStaleConfiguration.attemptId,
                fields: { token: 'stale-configuration' },
              })
            : null;
        if (typeof staleRevision !== 'string') {
          return {
            initialConfigurationAdmission,
            configurationCommitted,
            beginStaleConfiguration,
            staleConfigurationCommitted,
            staleConfigurationSubmit,
            qualifiedAccountsCapability,
          };
        }
        const configurationRestored = await control({
          operation: 'replaceConfiguration',
          target: {
            kind: 'service',
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'manual',
          },
          expectedRevision: staleRevision,
          values: { 'api-origin': configuredOrigin },
          secretValues: {},
        });
        const restoredRevision =
          configurationRestored.status === 'configurationCommitted'
            ? configurationRestored.configuration.revision
            : null;
        if (typeof restoredRevision !== 'string') {
          return {
            initialConfigurationAdmission,
            configurationCommitted,
            beginStaleConfiguration,
            staleConfigurationCommitted,
            staleConfigurationSubmit,
            configurationRestored,
            qualifiedAccountsCapability,
          };
        }
        const begin = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'manual',
          expectedConfigurationRevision: restoredRevision,
        });
        if (!begin.attemptId) {
          return {
            begin,
            initialConfigurationAdmission,
            configurationCommitted,
            beginStaleConfiguration,
            staleConfigurationCommitted,
            staleConfigurationSubmit,
            configurationRestored,
            qualifiedAccountsCapability,
          };
        }
        const submitAccountA = await command({
          operation: 'submitManual',
          attemptId: begin.attemptId,
          fields: {
            token: 'token-a',
          },
        });
        if (phase !== 'installed' || submitAccountA.status !== 'connected') {
          return {
            begin,
            initialConfigurationAdmission,
            configurationCommitted,
            beginStaleConfiguration,
            staleConfigurationCommitted,
            staleConfigurationSubmit,
            configurationRestored,
            submit: submitAccountA,
            qualifiedAccountsCapability,
          };
        }
        const beginAccountB = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'manual',
        });
        const submitAccountB = beginAccountB.attemptId
          ? await command({
              operation: 'submitManual',
              attemptId: beginAccountB.attemptId,
              fields: { token: 'token-b' },
            })
          : null;
        let qualifiedGroup = null;
        if (submitAccountB?.status === 'connected') {
          await mutateQualifiedGroup(
            '/v4/connect/qualified/groups',
            {
              service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
              group: {
                groupId: groupRef.groupId,
                displayName: 'Packed fallback accounts',
              },
            },
          );
          const qualifiedGroupWithAccountA = await mutateQualifiedGroup(
            '/v4/connect/qualified/group/members',
            {
              group: groupRef,
              connectedAccountId: 'account-a',
              priority: 10,
            },
          );
          const qualifiedGroupWithAccountB = await mutateQualifiedGroup(
            '/v4/connect/qualified/group/members',
            {
              group: groupRef,
              connectedAccountId: 'account-b',
              priority: 20,
              expectedRuntimeStateRevision:
                qualifiedGroupWithAccountA.runtimeStateRevision,
            },
          );
          qualifiedGroup = await mutateQualifiedGroup(
            '/v4/connect/qualified/group/active-account',
            {
              group: groupRef,
              connectedAccountId: 'account-b',
              expectedGeneration:
                qualifiedGroupWithAccountB.generation,
              expectedRuntimeStateRevision:
                qualifiedGroupWithAccountB.runtimeStateRevision,
            },
          );
        }
        const beginReconnectAccountA = await command({
          operation: 'beginReconnect',
          account: {
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            accountId: 'account-a',
          },
        });
        const submitReconnectAccountA = beginReconnectAccountA.attemptId
          ? await command({
              operation: 'submitManual',
              attemptId: beginReconnectAccountA.attemptId,
              fields: { token: 'token-a-reconnected' },
            })
          : null;
        let qualifiedGroupAfterReconnect = null;
        if (qualifiedGroup) {
          const encodedGroup = encodeURIComponent(
            encodeQualifiedConnectedAccountV4StructuredQueryValue(
              QualifiedConnectedAccountGroupRefSchema,
              groupRef,
            ),
          );
          const response = await fetch(
            new URL(
              `/v4/connect/qualified/group?group=${encodedGroup}`,
              `${serverBaseUrl}/`,
            ),
            {
              headers: {
                authorization: `Bearer ${auth.token}`,
              },
            },
          );
          if (!response.ok) {
            throw new Error(
              formatPackedQualifiedConnectedAccountHttpFailure({
                method: 'GET',
                path: `/v4/connect/qualified/group?group=${encodedGroup}`,
                status: response.status,
              }),
            );
          }
          qualifiedGroupAfterReconnect =
            QualifiedConnectedAccountGroupResponseV4Schema.parse(
              await response.json(),
            ).group;
        }
        const beginOutcomeUnknown = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'manual',
        });
        const submitOutcomeUnknown = beginOutcomeUnknown.attemptId
          ? await command({
              operation: 'submitManual',
              attemptId: beginOutcomeUnknown.attemptId,
              fields: { token: 'outcome-unknown' },
            })
          : null;
        const beginCancellation = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'manual',
        });
        const cancellation = beginCancellation.attemptId
          ? await command({
              operation: 'cancel',
              attemptId: beginCancellation.attemptId,
            })
          : null;
        const beginLateResult = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'manual',
        });
        const pendingLateResult = beginLateResult.attemptId
          ? command({
              operation: 'submitManual',
              attemptId: beginLateResult.attemptId,
              fields: { token: 'slow-token' },
            })
          : null;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        const cancelLateResult = beginLateResult.attemptId
          ? await command({
              operation: 'cancel',
              attemptId: beginLateResult.attemptId,
            })
          : null;
        const lateResult = pendingLateResult
          ? await pendingLateResult
          : null;
        const beginOAuthConfiguration = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'oauth',
        });
        const oauthConfigurationCommitted = await control({
          operation: 'replaceConfiguration',
          target: {
            kind: 'service',
            service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
            modeId: 'oauth',
          },
          expectedRevision: null,
          values: {
            'api-origin': configuredOrigin,
            'authorization-origin':
              PACKED_NOVEL_SIMULATED_AUTHORIZATION_ORIGIN,
            tenant: 'packed-tenant',
          },
          secretValues: {
            'client-secret': 'packed-oauth-client-secret',
          },
        });
        const oauthConfigurationRevision =
          oauthConfigurationCommitted.status === 'configurationCommitted'
            ? oauthConfigurationCommitted.configuration.revision
            : null;
        const beginOAuthStart = typeof oauthConfigurationRevision === 'string'
          ? await command({
              operation: 'beginConnect',
              service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
              modeId: 'oauth',
              expectedConfigurationRevision: oauthConfigurationRevision,
            })
          : null;
        const beginOAuth = beginOAuthStart?.attemptId
          ? await waitForAttemptStatus(
              beginOAuthStart.attemptId,
              'awaitingOAuth',
            )
          : beginOAuthStart;
        let parsedOAuthAuthorization: Readonly<{
          origin: string;
          pathname: string;
          responseType: string | null;
          state: string | null;
          redirectUri: string | null;
        }> | null = null;
        if (
          beginOAuth?.status === 'awaitingOAuth'
          && beginOAuth.authorizationUrl
        ) {
          try {
            const authorizationUrl = new URL(beginOAuth.authorizationUrl);
            parsedOAuthAuthorization = {
              origin: authorizationUrl.origin,
              pathname: authorizationUrl.pathname,
              responseType:
                authorizationUrl.searchParams.get('response_type'),
              state: authorizationUrl.searchParams.get('state'),
              redirectUri:
                authorizationUrl.searchParams.get('redirect_uri'),
            };
          } catch {
            parsedOAuthAuthorization = null;
          }
        }
        const providerCancellationStart = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'oauth',
          ...(typeof oauthConfigurationRevision === 'string'
            ? {
                expectedConfigurationRevision:
                  oauthConfigurationRevision,
              }
            : {}),
        });
        const beginProviderCancellation =
          providerCancellationStart.attemptId
            ? await waitForAttemptStatus(
                providerCancellationStart.attemptId,
                'awaitingOAuth',
              )
            : providerCancellationStart;
        const providerCancellation = beginProviderCancellation.attemptId
          ? await command({
              operation: 'cancel',
              attemptId: beginProviderCancellation.attemptId,
            })
          : null;
        const beginDeviceConfiguration = await command({
          operation: 'beginConnect',
          service: PACKED_NOVEL_CONNECTED_ACCOUNT_SERVICE,
          modeId: 'device',
        });
        const deviceConfigurationCommitted =
          beginDeviceConfiguration.attemptId
            ? await control({
                operation: 'replaceConfiguration',
                target: {
                  kind: 'attempt',
                  attemptId: beginDeviceConfiguration.attemptId,
                },
                expectedRevision: null,
                values: {
                  'api-origin': configuredOrigin,
                  workspace: 'packed-workspace',
                },
                secretValues: {
                  'account-secret': 'packed-device-account-secret',
                },
              })
            : null;
        const deviceConfigurationRevision =
          deviceConfigurationCommitted?.status === 'configurationCommitted'
            ? deviceConfigurationCommitted.configuration.revision
            : null;
        const continueDeviceStart = (
          beginDeviceConfiguration.attemptId
          && typeof deviceConfigurationRevision === 'string'
        )
          ? await command({
              operation: 'continueConnect',
              attemptId: beginDeviceConfiguration.attemptId,
              expectedConfigurationRevision: deviceConfigurationRevision,
            })
          : null;
        const continueDevice = continueDeviceStart?.attemptId
          ? await waitForAttemptStatus(
              continueDeviceStart.attemptId,
              'awaitingDeviceAuthorization',
            )
          : continueDeviceStart;
        return {
          begin,
          initialConfigurationAdmission,
          configurationCommitted,
          beginStaleConfiguration,
          staleConfigurationCommitted,
          staleConfigurationSubmit,
          configurationRestored,
          qualifiedAccountsCapability,
          submit: submitAccountA,
          beginAccountB,
          submitAccountB,
          beginReconnectAccountA,
          submitReconnectAccountA,
          qualifiedGroup,
          qualifiedGroupAfterReconnect,
          beginOutcomeUnknown,
          submitOutcomeUnknown,
          beginCancellation,
          cancellation,
          beginLateResult,
          cancelLateResult,
          lateResult,
          beginOAuthConfiguration,
          oauthConfigurationCommitted,
          beginOAuthStart,
          beginOAuth,
          oauthAuthorization: parsedOAuthAuthorization,
          beginProviderCancellation,
          providerCancellation,
          beginDeviceConfiguration,
          deviceConfigurationCommitted,
          continueDeviceStart,
          continueDevice,
        };
      },
      probeScm: async ({ phase, happyHomeDir, cwd, backendId, hostingProviderId }) => {
        const connection = await ensureUi(happyHomeDir);
        const projection = await callEncryptedMachineRpc({
          ui: connection.ui,
          machineId: connection.machineId,
          method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
          req: { machineId: connection.machineId },
          secret,
          schema: DaemonContributionRegistryProjectionDescribeResponseSchema,
        });
        if (phase === 'uninstalled') return { projection };

        const backendPreference = { kind: 'prefer' as const, backendId };
        const status = await callEncryptedMachineRpc({
          ui: connection.ui,
          machineId: connection.machineId,
          method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
          req: { cwd, backendPreference },
          secret,
          schema: ScmStatusSnapshotResponseSchema,
        });
        const repository = await callEncryptedMachineRpc({
          ui: connection.ui,
          machineId: connection.machineId,
          method: RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
          req: {
            cwd,
            backendPreference,
            providerId: hostingProviderId,
          },
          secret,
          schema: ScmHostingRepositoryDescribePublishTargetsResponseSchema,
        });
        return { projection, status, repository };
      },
      probeExternalSessions: async ({
        phase,
        happyHomeDir,
        agentId,
        source,
        candidateCursor,
        tailCursor,
        sessionId,
      }) => {
        const connection = await ensureUi(happyHomeDir);
        const call = async <T>(
          method: string,
          req: unknown,
          schema: MemoryRpcSchema<T>,
        ): Promise<T> => await callEncryptedMachineRpc({
          ui: connection.ui,
          machineId: connection.machineId,
          method,
          req,
          secret,
          schema,
        });
        const list = async (cursor?: string) => await call(
          RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
          {
            machineId: connection.machineId,
            agentId,
            source,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          },
          ExternalSessionsCandidatesListResponseSchema,
        );
        const qualifiedAgent = {
          pluginId: 'acme.vertical-a',
          localId: agentId,
        } as const;
        const hookStatus = async (
          input:
            | Readonly<{ intent: 'install_preview' }>
            | Readonly<{
                intent: 'passive_inventory';
                limit?: number;
              }>,
        ) => await call(
          RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
          {
            machineId: connection.machineId,
            agent: qualifiedAgent,
            ...input,
          },
          PluginSessionHookStatusResponseV1Schema,
        );
        if (phase === 'uninstalled') {
          const hooksBeforeUninstall = await hookStatus({
            intent: 'passive_inventory',
            limit: 50,
          });
          const hookUninstall = packedHookInstallationId
            ? await call(
                RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL,
                {
                  machineId: connection.machineId,
                  agent: qualifiedAgent,
                  installationId: packedHookInstallationId,
                },
                PluginSessionHookUninstallResponseV1Schema,
              )
            : null;
          return {
            candidates: await list(),
            hooksBeforeUninstall,
            hookUninstall,
            hookConfigAfterUninstall: packedHookTargetPath
              ? JSON.parse(await readFile(packedHookTargetPath, 'utf8'))
              : null,
          };
        }
        if (phase === 'restarted') {
          if (!candidateCursor || !tailCursor || !sessionId) {
            throw new Error('Packed External Sessions restart probe requires prior cursors and linked session');
          }
          return {
            candidates: await list(candidateCursor),
            hookStatus: await hookStatus({
              intent: 'passive_inventory',
              limit: 50,
            }),
            link: await call(
              RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
              {
                machineId: connection.machineId,
                agentId,
                remoteSessionId: 'packed-session-0',
                source,
              },
              ExternalSessionLinkEnsureResponseSchema,
            ),
            readAfter: await call(
              RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
              {
                machineId: connection.machineId,
                agentId,
                remoteSessionId: 'packed-session-0',
                source,
                cursor: tailCursor,
                maxItems: 1,
              },
              ExternalSessionTranscriptReadAfterResponseSchema,
            ),
          };
        }
        if (phase === 'replaced') {
          if (!candidateCursor || !tailCursor) {
            throw new Error('Packed External Sessions replacement probe requires prior cursors');
          }
          const staleCandidates = await list(candidateCursor);
          const staleReadAfter = await call(
            RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
            {
              machineId: connection.machineId,
              agentId,
              remoteSessionId: 'packed-session-0',
              source,
              cursor: tailCursor,
              maxItems: 1,
            },
            ExternalSessionTranscriptReadAfterResponseSchema,
          );
          const candidates = await list();
          const page = await call(
            RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
            {
              machineId: connection.machineId,
              agentId,
              remoteSessionId: 'packed-session-0',
              source,
              direction: 'older',
              maxItems: 1,
            },
            ExternalSessionTranscriptPageResponseSchema,
          );
          if (!page.ok || !page.tailCursor) {
            return {
              staleCandidates,
              staleReadAfter,
              candidates,
              page,
              hookStatus: await hookStatus({
                intent: 'passive_inventory',
                limit: 50,
              }),
            };
          }
          const readAfter = await call(
            RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
            {
              machineId: connection.machineId,
              agentId,
              remoteSessionId: 'packed-session-0',
              source,
              cursor: page.tailCursor,
              maxItems: 1,
            },
            ExternalSessionTranscriptReadAfterResponseSchema,
          );
          return {
            staleCandidates,
            staleReadAfter,
            candidates,
            page,
            readAfter,
            hookStatus: await hookStatus({
              intent: 'passive_inventory',
              limit: 50,
            }),
          };
        }
        const candidates = await list();
        const hookPreview = await hookStatus({
          intent: 'install_preview',
        });
        const previewRow = hookPreview.ok ? hookPreview.rows[0] : undefined;
        const hookInstall = (
          phase === 'installed'
          && previewRow?.status.state === 'not_installed'
          && previewRow.status.installPreview
        )
          ? await call(
              RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL,
              {
                machineId: connection.machineId,
                agent: qualifiedAgent,
                expectedPreviewId:
                  previewRow.status.installPreview.previewId,
              },
              PluginSessionHookInstallResponseV1Schema,
            )
          : null;
        if (hookInstall?.ok === true) {
          packedHookInstallationId = hookInstall.status.installationId;
        }
        const hooksAfterInstall = phase === 'installed'
          ? await hookStatus({
              intent: 'passive_inventory',
              limit: 50,
            })
          : hookPreview;
        const hookConfig = packedHookTargetPath
          ? JSON.parse(await readFile(packedHookTargetPath, 'utf8'))
          : null;
        if (!candidates.ok || candidates.candidates.length === 0) {
          return {
            candidates,
            hookPreview,
            hookInstall,
            hooksAfterInstall,
            hookConfig,
          };
        }
        const candidate = candidates.candidates[0]!;
        const link = await call(
          RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
          {
            machineId: connection.machineId,
            agentId,
            remoteSessionId: candidate.remoteSessionId,
            source,
            ...(candidate.title ? { titleHint: candidate.title } : {}),
            ...(candidate.linkData ? { linkData: candidate.linkData } : {}),
          },
          ExternalSessionLinkEnsureResponseSchema,
        );
        const status = link.ok
          ? await call(
              RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
              {
                machineId: connection.machineId,
                sessionId: link.sessionId,
                agentId,
                remoteSessionId: candidate.remoteSessionId,
                source,
              },
              ExternalSessionStatusGetResponseSchema,
            )
          : null;
        const page = await call(
          RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
          {
            machineId: connection.machineId,
            agentId,
            remoteSessionId: candidate.remoteSessionId,
            source,
            direction: 'older',
            maxItems: 1,
          },
          ExternalSessionTranscriptPageResponseSchema,
        );
        if (!page.ok || !page.tailCursor) {
          return {
            candidates,
            link,
            status,
            page,
            hookPreview,
            hookInstall,
            hooksAfterInstall,
            hookConfig,
          };
        }
        const readAfter = await call(
          RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
          {
            machineId: connection.machineId,
            agentId,
            remoteSessionId: candidate.remoteSessionId,
            source,
            cursor: page.tailCursor,
            maxItems: 1,
          },
          ExternalSessionTranscriptReadAfterResponseSchema,
        );
        return {
          candidates,
          link,
          status,
          page,
          readAfter,
          hookPreview,
          hookInstall,
          hooksAfterInstall,
          hookConfig,
        };
      },
      probeNotifications: async ({ phase, happyHomeDir, pluginId }) => {
        const connection = await ensureUi(happyHomeDir);
        if (
          phase === 'configure'
          || phase === 'credential-invalid'
          || phase === 'credential-valid'
        ) {
          if (phase === 'configure') {
            await callEncryptedMachineRpc({
              ui: connection.ui,
              machineId: connection.machineId,
              method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
              req: {
                machineId: connection.machineId,
                pluginId,
                fieldId: 'webhook.endpoint',
                value: 'https://notifications.example.test/deliver',
              },
              secret,
              schema: DaemonPluginSettingsSetResponseSchema,
            });
          }
          const credential = phase === 'credential-invalid'
            ? 'invalid-notification-token'
            : 'configured-notification-token';
          const snapshot = await callEncryptedMachineRpc({
            ui: connection.ui,
            machineId: connection.machineId,
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
            req: {
              machineId: connection.machineId,
              pluginId,
              fieldId: 'webhook.token',
              value: credential,
            },
            secret,
            schema: DaemonPluginSettingsSetResponseSchema,
          });
          if (JSON.stringify(snapshot).includes(credential)) {
            throw new Error('Notification settings RPC exposed credential material');
          }
          return snapshot;
        }

        const enabled = phase === 'policy-enabled';
        const current = await readEncryptedAccountSettingsV2OrEmpty({
          baseUrl: serverBaseUrl,
          token: auth.token,
          secret,
        });
        const currentPolicy = current.settings.attentionDeliveryPolicyV1;
        const nextPolicy = {
          ...currentPolicy,
          channels: {
            ...currentPolicy.channels,
            webhook: {
              ...currentPolicy.channels.webhook,
              enabled,
            },
          },
        };
        const settingsVersion = await upsertEncryptedAccountSettingsV2({
          baseUrl: serverBaseUrl,
          token: auth.token,
          secret,
          expectedVersion: current.settingsVersion,
          settings: accountSettingsParse({
            ...current.settings,
            attentionDeliveryPolicyV1: nextPolicy,
          }),
        });
        return { settingsVersion, webhookEnabled: enabled };
      },
    });
    closeSocketCollector(ui);
    ui = null;
    const completedServer = server;
    server = null;
    await completedServer.stop();
    const serverLogEvidence = await Promise.all([
      'server.stdout.log',
      'server.stderr.log',
      'server.migrate.stdout.log',
      'server.migrate.stderr.log',
      'server.template.migrate.stdout.log',
      'server.template.migrate.stderr.log',
      'server.sharedDeps.stdout.log',
      'server.sharedDeps.stderr.log',
      'server.generate.stdout.log',
      'server.generate.stderr.log',
    ].map(async (fileName) => {
      try {
        return await readFile(resolve(testDir, fileName), 'utf8');
      } catch (error) {
        if (
          error
          && typeof error === 'object'
          && 'code' in error
          && error.code === 'ENOENT'
        ) {
          return '';
        }
        throw error;
      }
    }));
    assertPackedAuthorCredentialSentinelsAbsent({
      commandOutputs: [],
      logs: serverLogEvidence,
      markerLog: '',
      result,
    });
    assertPackedAuthorCredentialSentinelsAbsent({
      commandOutputs: [],
      logs: serverLogEvidence,
      markerLog: '',
      result,
      sentinels: [
        auth.token,
        Buffer.from(secret).toString('base64'),
        Buffer.from(secret).toString('hex'),
      ],
    });
    return result;
  } finally {
    closeSocketCollector(ui);
    await server?.stop().catch(() => undefined);
  }
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const startedAt = new Date().toISOString();
  let candidate: PackedAuthorCandidate | null = null;
  try {
    const { packedNovelQaHandoffRoot } = parseRunnerArgs(argv);
    candidate = await loadCandidate(argv);
    const result = await runPackedAuthorVerticalAWithTestServer(candidate, {
      ...(packedNovelQaHandoffRoot
        ? { packedNovelQaHandoffRoot }
        : {}),
    });
    process.stdout.write(`${JSON.stringify({
      ...result,
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      scenario: 'vertical-a',
      candidate: candidate ? { runId: candidate.runId, sdk: candidate.sdk, cli: candidate.cli } : null,
      error: {
        code: 'packed_author_boundary_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      cleanup: { disposition: 'attempted' },
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
