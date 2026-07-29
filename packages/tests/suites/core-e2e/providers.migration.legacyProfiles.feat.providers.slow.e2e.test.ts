import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  AccountSettingsV2GetResponseSchema,
  buildBackendTargetKeyV2,
  canonicalizeProviderContributionKeyV1,
  DEFAULT_PROVIDER_SETTINGS_V1,
  deriveSettingsSecretsKeyV1,
  getBuiltInBackendProfile,
  normalizeCustomProviderTemplateV1,
  openAccountScopedBlobCiphertext,
  ProviderConnectionIdSchema,
  readAiLaunchProfileCollection,
  readProviderSettingsFromAccountSettingsV1,
  sealSecretsDeepV1,
  SessionModelSelectionIntentV1Schema,
  type AccountSettingsStoredContentEnvelope,
} from '@happier-dev/protocol';
import {
  DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelSettingsMutationResponseV1Schema,
  DaemonProviderProfileMigrationConfirmResponseV1Schema,
  DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
  DaemonProviderProfileMigrationPreviewResponseV1Schema,
  RPC_METHODS,
} from '@happier-dev/protocol/rpc';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  createIsolatedFakeClaudeControlShim,
  waitForFakeClaudeInvocation,
  waitForFakeClaudeUserText,
} from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { callEncryptedMachineRpc } from '../../src/testkit/memoryRpc';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
  resolveCliTestLaunchSpec,
  type CliTestLaunchSpec,
} from '../../src/testkit/process/cliLaunchSpec';
import {
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
} from '../../src/testkit/providers/scenarios/sessionRuntime';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type JsonRecord = Record<string, unknown>;

/**
 * Immutable old-writer → new-reader Q19 vector.
 *
 * Producer: `cli-v0.2.1` at `b1d15a8a9c241737d1ca9b167459901e6259173a`.
 * Released descriptor blobs:
 * - DeepSeek: `packages/protocol/src/providers/claude/builtInBackendProfiles.ts`
 *   (`304a5817052cd384d68847af9308c2e641c8f5c8`)
 * - Gemini: `packages/protocol/src/providers/gemini/builtInBackendProfiles.ts`
 *   (`41515d6732d998541caaea5de8f0eaf3022e4860`)
 * Released persisted-setting writers:
 * - Profile/last-used/secret/binding definitions:
 *   `apps/ui/sources/sync/domains/settings/registry/account/accountProfilesSettingDefinitions.ts`
 *   (`d1391fcf7c6b99779ee2a36a66f092553430db98`)
 * - Favorite Profile definition:
 *   `apps/ui/sources/sync/domains/settings/registry/account/accountCollectionSettingDefinitions.ts`
 *   (`bd9dd1b22a601e1a5de388c7aac8e3712d8f75eb`)
 * - Exact DeepSeek SavedSecret/binding example:
 *   `apps/cli/src/settings/profiles/buildProfileEnvOverlay.test.ts`
 *   (`a930e0a843eba2e9b9cc6debf47da2879ac278cd`)
 *
 * The built-in descriptor rows were code-owned; the account writer persisted
 * the selection, SavedSecret id, binding, favorite, last-used, and custom/raw
 * Profile rows below. Keep this as raw JSON data: do not rebuild it through
 * current Profile constructors or schemas. Discriminators are the DeepSeek
 * secret/favorite/last-used ids, Gemini's generated model pin, the custom
 * routing row, and opaque Profile/top-level/sidecar data. The opaque values
 * are adjacent forward-data preservation probes, not attributed to the old
 * writer.
 */
const RELEASED_CLI_V0_2_1_Q19_VECTOR = {
  deepseek: {
    savedSecret: {
      id: 's1',
      name: 'DeepSeek',
      kind: 'apiKey',
      encryptedValue: {
        _isSecretValue: true,
        encryptedValue: { t: 'enc-v1', c: 'ZGVlcHNlZWs=' },
      },
      createdAt: 0,
      updatedAt: 0,
    },
    secretBinding: { DEEPSEEK_AUTH_TOKEN: 's1' },
    enabled: true,
    favoriteProfileId: 'deepseek',
    lastUsedProfile: 'deepseek',
  },
  geminiApiKeyProfile: {
    id: 'gemini-api-key',
    name: 'Gemini (API key)',
    envVarRequirements: [{ name: 'GEMINI_API_KEY', kind: 'secret', required: true }],
    environmentVariables: [{ name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' }],
    defaultPermissionModeByTargetKey: { 'agent:gemini': 'default' },
    defaultPermissionModeByAgent: {},
    defaultPersistenceModeByTargetKey: {},
    defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: {
      'agent:claude': false,
      'agent:codex': false,
      'agent:gemini': true,
    },
    compatibility: {},
    isBuiltIn: true,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
  },
  customProfile: {
    id: 'company-gateway',
    name: 'Company gateway',
    environmentVariables: [
      { name: 'OPENAI_BASE_URL', value: 'https://gateway.example.test/v1' },
      { name: 'COMPANY_TIMEOUT_MS', value: '120000' },
    ],
    envVarRequirements: [
      { name: 'COMPANY_API_KEY', kind: 'secret', required: true },
    ],
    defaultPermissionModeByTargetKey: {},
    defaultPermissionModeByAgent: {},
    defaultPersistenceModeByTargetKey: {},
    defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: { 'agent:codex': true },
    compatibility: {},
    isBuiltIn: false,
    createdAt: 10,
    updatedAt: 10,
    version: '1.0.0',
  },
  opaqueFutureProfile: {
    v: 99,
    id: 'future-profile',
    opaque: { preserve: ['exactly'] },
  },
  opaqueProfileSidecar: {
    FUTURE_API_KEY: 'future-secret-reference',
  },
  opaqueTopLevel: {
    nested: ['must', 'round-trip'],
    futureProfileId: 'future-profile',
  },
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readTextEvidenceFiles(root: string): Promise<readonly string[]> {
  const contents: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        return;
      }
      if (!entry.isFile() || (!entry.name.endsWith('.log') && !entry.name.endsWith('.jsonl'))) return;
      contents.push(await readFile(path, 'utf8'));
    }));
  };
  await visit(root);
  return contents;
}

function openEncryptedSettings(
  content: AccountSettingsStoredContentEnvelope | null,
  secret: Uint8Array,
): JsonRecord {
  if (!content || content.t !== 'encrypted') {
    throw new Error('Expected encrypted account settings');
  }
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material: { type: 'legacy', secret },
    ciphertext: content.c,
  });
  if (!opened?.value || typeof opened.value !== 'object' || Array.isArray(opened.value)) {
    throw new Error('Expected an encrypted account-settings object');
  }
  return opened.value as JsonRecord;
}

async function readEncryptedSettings(params: Readonly<{
  baseUrl: string;
  token: string;
  secret: Uint8Array;
}>): Promise<Readonly<{ version: number; settings: JsonRecord }>> {
  const response = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  expect(response.status).toBe(200);
  const parsed = AccountSettingsV2GetResponseSchema.parse(response.data);
  return {
    version: parsed.version,
    settings: openEncryptedSettings(parsed.content, params.secret),
  };
}

describe('core e2e: encrypted legacy profile migration', () => {
  let server: StartedServer | null = null;
  let daemons: StartedDaemon[] = [];
  let cliLaunchSpec: CliTestLaunchSpec;

  beforeAll(async () => {
    const launchSpecDir = resolve(join(run.runDir, 'shared-cli-source'));
    cliLaunchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: launchSpecDir,
        env: {
          ...process.env,
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
        },
      },
      {
        snapshotDir: resolve(join(launchSpecDir, 'snapshot')),
        preferSourceEntrypoint: true,
        skipDistIntegrityCheck: true,
        skipSourceFreshnessCheck: true,
      },
    );
  }, 600_000);

  afterEach(async () => {
    await Promise.all(daemons.map(async (daemon) => daemon.stop().catch(() => {})));
    daemons = [];
    await server?.stop().catch(() => {});
    server = null;
  }, 120_000);

  afterAll(async () => {
    if (cliLaunchSpec?.cwd) {
      await rm(cliLaunchSpec.cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it('converges two daemon migrations without losing secrets, unknown fields, or retained profiles', async () => {
    const testDir = run.testDir(`providers-legacy-migration-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    const secret = Uint8Array.from(randomBytes(32));

    const azure = getBuiltInBackendProfile('azure-openai');
    if (!azure) throw new Error('Missing retained Azure legacy profile fixture');
    const company = RELEASED_CLI_V0_2_1_Q19_VECTOR.customProfile;
    const opaqueFutureProfile = RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueFutureProfile;
    const savedSecrets = [
      RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.savedSecret,
      {
        id: 'secret-azure',
        name: 'Azure legacy',
        kind: 'apiKey',
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'YXp1cmU=' },
        },
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'secret-company',
        name: 'Company legacy',
        kind: 'apiKey',
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'Y29tcGFueQ==' },
        },
        createdAt: 3,
        updatedAt: 3,
      },
    ] as const;
    const seedSettings = {
      schemaVersion: 7,
      useProfiles: true,
      profiles: [
        azure,
        RELEASED_CLI_V0_2_1_Q19_VECTOR.geminiApiKeyProfile,
        company,
        opaqueFutureProfile,
      ],
      secrets: savedSecrets,
      secretBindingsByProfileId: {
        deepseek: RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.secretBinding,
        'azure-openai': { AZURE_OPENAI_API_KEY: 'secret-azure' },
        'company-gateway': { COMPANY_API_KEY: 'secret-company' },
        'future-profile': RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueProfileSidecar,
      },
      profileEnabledById: {
        deepseek: RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.enabled,
        'azure-openai': true,
        'company-gateway': true,
      },
      favoriteProfiles: [
        'anthropic',
        RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.favoriteProfileId,
        'azure-openai',
        'company-gateway',
      ],
      lastUsedProfile: RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.lastUsedProfile,
      unknownFutureKey: RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueTopLevel,
    } as const;
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret,
      settings: seedSettings,
    });

    const homes = [resolve(join(testDir, 'daemon-a')), resolve(join(testDir, 'daemon-b'))];
    const seededMachines = await Promise.all(homes.map(async (home) => {
      await mkdir(home, { recursive: true });
      return await seedCliAuthForServer({
        cliHome: home,
        serverUrl: server!.baseUrl,
        token: auth.token,
        secret,
      });
    }));
    daemons = await Promise.all(homes.map(async (home, index) => startTestDaemon({
      testDir: resolve(join(testDir, `daemon-${index + 1}-runtime`)),
      happyHomeDir: home,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: server!.baseUrl,
        HAPPIER_WEBAPP_URL: server!.baseUrl,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
      startupTimeoutMs: 180_000,
      cliLaunchSpec,
    })));

    await waitFor(async () => {
      const current = await readEncryptedSettings({
        baseUrl: server!.baseUrl,
        token: auth.token,
        secret,
      });
      const providerSettings = readProviderSettingsFromAccountSettingsV1(current.settings).settings;
      const outcomes = providerSettings.migration?.completedSources ?? [];
      const deepseekOutcome = outcomes.find((entry) => entry.sourceProfileId === 'deepseek');
      const defaultEnvironmentOutcome = outcomes.find((entry) => entry.sourceProfileId === 'anthropic');
      if (deepseekOutcome?.kind !== 'connection' || defaultEnvironmentOutcome?.kind !== 'default_environment') {
        return false;
      }
      if (!providerSettings.migration?.pendingCustomProfileIds.includes('company-gateway')) {
        return false;
      }
      return true;
    }, { timeoutMs: 180_000, context: 'legacy provider migration convergence' });

    const final = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });
    const finalVersion = final.version;
    const finalSettings = final.settings;
    const providerSettings = readProviderSettingsFromAccountSettingsV1(finalSettings).settings;
    const deepseekOutcomes = providerSettings.migration?.completedSources.filter(
      (entry) => entry.sourceProfileId === 'deepseek' && entry.kind === 'connection',
    ) ?? [];
    expect(deepseekOutcomes).toHaveLength(1);
    const deepseekOutcome = deepseekOutcomes[0];
    if (!deepseekOutcome || deepseekOutcome.kind !== 'connection') {
      throw new Error('Expected one migrated DeepSeek connection outcome');
    }
    expect(deepseekOutcome).toMatchObject({
      sourceRevision: 2,
      modelSelectionOrigin: 'implicit_default',
      modelSelection: {
        modelId: 'deepseek-v4-flash',
      },
    });
    const deepseekConnectionId = deepseekOutcome.connectionId;
    const deepseekConnections = providerSettings.connections.filter((connection) =>
      connection.source.kind === 'contribution'
      && connection.source.contributionKey.includes('happier.provider.deepseek')
      && connection.role === 'default');
    expect(deepseekConnections).toEqual([
      expect.objectContaining({ id: deepseekConnectionId, displayNameMode: 'automatic' }),
    ]);
    expect(providerSettings.secretBindingsByConnectionId[deepseekConnectionId]).toEqual({
      account: { apiKey: RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.savedSecret.id },
    });
    expect(providerSettings.migration?.pendingCustomProfileIds).toContain('company-gateway');
    expect(providerSettings.migration?.pendingConflicts).toEqual([]);

    expect(finalSettings.schemaVersion).toBe(7);
    expect(finalSettings.secrets).toEqual(savedSecrets);
    expect(finalSettings.unknownFutureKey).toEqual(seedSettings.unknownFutureKey);
    const finalProfiles = finalSettings.profiles as unknown[];
    expect(finalProfiles).toEqual(expect.arrayContaining([
      azure,
      RELEASED_CLI_V0_2_1_Q19_VECTOR.geminiApiKeyProfile,
      company,
      opaqueFutureProfile,
      expect.objectContaining({ v: 2, id: 'deepseek' }),
    ]));
    const geminiRead = readAiLaunchProfileCollection(finalProfiles);
    const projectedGemini = geminiRead.entries.find((entry) =>
      entry.kind === 'legacy' && entry.profile.id === 'gemini-api-key');
    expect(projectedGemini?.kind).toBe('legacy');
    if (projectedGemini?.kind !== 'legacy') {
      throw new Error('Expected released Gemini API-key Profile to remain readable');
    }
    expect(projectedGemini.profile.environmentVariables).toEqual([]);
    expect(geminiRead.raw).toEqual(expect.arrayContaining([
      RELEASED_CLI_V0_2_1_Q19_VECTOR.geminiApiKeyProfile,
    ]));
    expect((finalSettings.secretBindingsByProfileId as JsonRecord)['azure-openai']).toEqual({
      AZURE_OPENAI_API_KEY: 'secret-azure',
    });
    expect((finalSettings.secretBindingsByProfileId as JsonRecord)['company-gateway']).toEqual({
      COMPANY_API_KEY: 'secret-company',
    });
    expect((finalSettings.secretBindingsByProfileId as JsonRecord)['future-profile']).toEqual({
      FUTURE_API_KEY: 'future-secret-reference',
    });
    expect((finalSettings.secretBindingsByProfileId as JsonRecord).deepseek).toBeUndefined();
    expect(finalSettings.favoriteProfiles).toEqual(['azure-openai', 'company-gateway']);
    expect(finalSettings.lastUsedProfile).toBe('deepseek');
    expect(finalSettings.favoriteModelSelectionsV1).toEqual([
      expect.objectContaining({
        selection: expect.objectContaining({
          ref: expect.objectContaining({
            providerConnectionId: deepseekConnectionId,
            modelId: 'deepseek-v4-flash',
          }),
        }),
      }),
    ]);

    // Let both daemons observe the winning version again. The migration must be
    // idempotent across independent invocations, not merely within one retry loop.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    const stable = await readEncryptedSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret,
    });
    expect(stable.version).toBe(finalVersion);
    expect(stable.settings).toEqual(finalSettings);

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(async () => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'provider migration UI socket connection',
      });
      const companyConnectionId = ProviderConnectionIdSchema.parse('pc_company_guided');
      const reviewedMapping = {
        connection: {
          v: 1 as const,
          id: companyConnectionId,
          source: {
            kind: 'custom' as const,
            template: normalizeCustomProviderTemplateV1({
              name: 'Company gateway',
              protocol: 'openai-responses',
              baseUrl: 'https://gateway.example.test/v1',
              credentialStyle: 'bearer',
              catalog: 'manual',
            }),
          },
          role: 'named' as const,
          displayName: 'Company gateway',
          displayNameMode: 'custom' as const,
          revision: 0,
          createdAt: 20,
          updatedAt: 20,
        },
        credentialMoves: [{
          legacyEnvVarName: 'COMPANY_API_KEY',
          credentialSlotId: 'apiKey',
          credentialStyle: 'bearer' as const,
        }],
        routingEnvironmentVariableNames: ['OPENAI_BASE_URL'],
        manualModelIds: ['company-model'],
        selectedModel: { agentTargetKey: 'agent:codex', modelId: 'company-model' },
      };
      const migrationMachineId = seededMachines[0]!.machineId;
      const preview = await callEncryptedMachineRpc({
        ui,
        machineId: migrationMachineId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW,
        req: {
          machineId: migrationMachineId,
          sourceProfileId: 'company-gateway',
          reviewedMapping,
        },
        secret,
        schema: DaemonProviderProfileMigrationPreviewResponseV1Schema,
        timeoutMs: 90_000,
      });
      expect(preview.status).toBe('success');
      if (preview.status !== 'success') throw new Error('Expected guided migration preview');
      const afterPreview = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });
      expect(afterPreview.version).toBe(finalVersion);
      expect(afterPreview.settings).toEqual(finalSettings);

      // Change the exact source after review. Confirmation must fail atomically,
      // then a new preview of the changed source may be confirmed.
      const changedCompany = {
        ...company,
        environmentVariables: company.environmentVariables.map((entry) =>
          entry.name === 'COMPANY_TIMEOUT_MS'
            ? { ...entry, value: '180000' }
            : entry),
        updatedAt: 11,
      };
      await upsertEncryptedAccountSettingsV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        secret,
        settings: {
          ...afterPreview.settings,
          profiles: (afterPreview.settings.profiles as unknown[]).map((profile) =>
            profile && typeof profile === 'object' && !Array.isArray(profile)
              && (profile as JsonRecord).id === 'company-gateway'
              ? changedCompany
              : profile),
        },
      });
      const staleConfirm = await callEncryptedMachineRpc({
        ui,
        machineId: migrationMachineId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM,
        req: {
          machineId: migrationMachineId,
          sourceProfileId: 'company-gateway',
          reviewedMapping,
          expectedSourceFingerprint: preview.sourceFingerprint,
        },
        secret,
        schema: DaemonProviderProfileMigrationConfirmResponseV1Schema,
        timeoutMs: 90_000,
      });
      expect(staleConfirm).toMatchObject({
        status: 'error',
        error: { code: 'provider_profile_migration_source_changed' },
      });
      const afterRefusal = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });
      expect(readProviderSettingsFromAccountSettingsV1(afterRefusal.settings).settings.connections)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: companyConnectionId })]));
      expect((afterRefusal.settings.secretBindingsByProfileId as JsonRecord)['company-gateway'])
        .toEqual({ COMPANY_API_KEY: 'secret-company' });

      const freshPreview = await callEncryptedMachineRpc({
        ui,
        machineId: migrationMachineId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW,
        req: {
          machineId: migrationMachineId,
          sourceProfileId: 'company-gateway',
          reviewedMapping,
        },
        secret,
        schema: DaemonProviderProfileMigrationPreviewResponseV1Schema,
        timeoutMs: 90_000,
      });
      expect(freshPreview.status).toBe('success');
      if (freshPreview.status !== 'success') throw new Error('Expected refreshed migration preview');
      const confirmed = await callEncryptedMachineRpc({
        ui,
        machineId: migrationMachineId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM,
        req: {
          machineId: migrationMachineId,
          sourceProfileId: 'company-gateway',
          reviewedMapping,
          expectedSourceFingerprint: freshPreview.sourceFingerprint,
        },
        secret,
        schema: DaemonProviderProfileMigrationConfirmResponseV1Schema,
        timeoutMs: 90_000,
      });
      expect(confirmed).toMatchObject({
        status: 'success',
        sourceProfileId: 'company-gateway',
        connectionId: companyConnectionId,
      });

      const guidedFinal = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });
      const guidedProviderSettings = readProviderSettingsFromAccountSettingsV1(guidedFinal.settings).settings;
      expect(guidedProviderSettings.connections).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: companyConnectionId, role: 'named' }),
      ]));
      expect(guidedProviderSettings.secretBindingsByConnectionId[companyConnectionId]).toEqual({
        account: { apiKey: 'secret-company' },
      });
      expect(guidedProviderSettings.manualModelsByConnectionId[companyConnectionId]).toEqual([
        expect.objectContaining({ id: 'company-model' }),
      ]);
      expect(guidedProviderSettings.migration?.pendingCustomProfileIds).not.toContain('company-gateway');
      expect(guidedProviderSettings.migration?.completedSources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceProfileId: 'company-gateway',
          kind: 'connection',
          connectionId: companyConnectionId,
        }),
      ]));
      expect((guidedFinal.settings.secretBindingsByProfileId as JsonRecord)['company-gateway']).toBeUndefined();
      expect(guidedFinal.settings.profiles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          v: 2,
          id: 'company-gateway',
          extraEnvironmentVariables: [{ name: 'COMPANY_TIMEOUT_MS', value: '180000' }],
        }),
        azure,
        RELEASED_CLI_V0_2_1_Q19_VECTOR.geminiApiKeyProfile,
        opaqueFutureProfile,
      ]));
      expect(guidedFinal.settings.secrets).toEqual(savedSecrets);
      expect(guidedFinal.settings.unknownFutureKey).toEqual(seedSettings.unknownFutureKey);
    } finally {
      ui.close();
    }
  }, 360_000);

  it('restarts a migrated account and launches the exact Provider-bound Claude model without native fallback', async () => {
    const testDir = run.testDir(`providers-legacy-restart-launch-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    const secret = Uint8Array.from(randomBytes(32));
    const providerSecret = `sk-provider-migrated-${randomUUID()}`;
    const ambientNativeApiKey = `sk-ant-native-${randomUUID()}`;
    const ambientNativeOauthToken = `native-oauth-${randomUUID()}`;
    const savedSecretId = RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.savedSecret.id;
    const seededSettings = sealSecretsDeepV1({
      schemaVersion: 7,
      useProfiles: true,
      profiles: [
        RELEASED_CLI_V0_2_1_Q19_VECTOR.geminiApiKeyProfile,
        RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueFutureProfile,
      ],
      secrets: [{
        ...RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.savedSecret,
        encryptedValue: { _isSecretValue: true as const, value: providerSecret },
      }],
      secretBindingsByProfileId: {
        deepseek: RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.secretBinding,
        'future-profile': RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueProfileSidecar,
      },
      profileEnabledById: { deepseek: RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.enabled },
      favoriteProfiles: [RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.favoriteProfileId],
      lastUsedProfile: RELEASED_CLI_V0_2_1_Q19_VECTOR.deepseek.lastUsedProfile,
      unknownFutureKey: RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueTopLevel,
    }, deriveSettingsSecretsKeyV1(secret), (length) => Uint8Array.from(randomBytes(length)));
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret,
      settings: seededSettings,
    });

    const daemonHome = resolve(join(testDir, 'daemon-home'));
    const workspace = resolve(join(testDir, 'workspace'));
    await Promise.all([mkdir(daemonHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
    const seeded = await seedCliAuthForServer({
      cliHome: daemonHome,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });
    const invocationId = `migrated-provider-launch-${randomUUID()}`;
    const fakeClaudeFixture = await createIsolatedFakeClaudeControlShim({
      testDir,
      invocationId,
      captureEnvironmentKeys: [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ],
      logFullStdin: true,
    });
    const fakeClaudeLogPath = fakeClaudeFixture.logPath;
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudeFixture.executablePath,
      // Keep valid-shaped native credentials present at the daemon boundary. The
      // migrated Provider binding must replace/clear them in the child scope.
      ANTHROPIC_API_KEY: ambientNativeApiKey,
      CLAUDE_CODE_OAUTH_TOKEN: ambientNativeOauthToken,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };

    const firstDaemon = await startTestDaemon({
      testDir: resolve(join(testDir, 'daemon-before-restart')),
      happyHomeDir: daemonHome,
      env: daemonEnv,
      startupTimeoutMs: 180_000,
      cliLaunchSpec,
    });
    daemons = [firstDaemon];

    let migratedConnectionId: ReturnType<typeof ProviderConnectionIdSchema.parse> | null = null;
    await waitFor(async () => {
      const current = await readEncryptedSettings({ baseUrl: server!.baseUrl, token: auth.token, secret });
      const providerSettings = readProviderSettingsFromAccountSettingsV1(current.settings).settings;
      const outcome = providerSettings.migration?.completedSources.find(
        (entry) => entry.sourceProfileId === 'deepseek',
      );
      if (outcome?.kind !== 'connection') return false;
      const connectionId = outcome.connectionId;
      migratedConnectionId = connectionId;
      return providerSettings.accountGrants.some((grant) => grant.connectionId === connectionId)
        && providerSettings.secretBindingsByConnectionId[connectionId]?.account?.apiKey === savedSecretId;
    }, { timeoutMs: 180_000, context: 'migrated Provider launch account readiness' });
    if (migratedConnectionId === null) throw new Error('Expected migrated Provider connection id');
    const migrated = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });
    const migratedProviderSettings = readProviderSettingsFromAccountSettingsV1(migrated.settings).settings;
    expect(migratedProviderSettings.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: migratedConnectionId,
        source: {
          kind: 'contribution',
          contributionKey: 'happier.provider.deepseek/deepseek',
        },
      }),
    ]));
    expect(migratedProviderSettings.migration?.completedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceProfileId: 'deepseek',
        kind: 'connection',
        connectionId: migratedConnectionId,
        modelSelection: {
          agentTargetKey: 'backend:claude',
          providerConnectionId: migratedConnectionId,
          modelId: 'deepseek-v4-flash',
        },
      }),
    ]));

    const agentTargetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'migrated Provider compatibility review UI socket connects',
      });
      const projection = await callEncryptedMachineRpc({
        ui,
        machineId: seeded.machineId,
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        req: {
          machineId: seeded.machineId,
          agentTargetKey,
          mode: 'picker',
        },
        secret,
        schema: DaemonProviderModelProjectionResponseV1Schema,
        timeoutMs: 90_000,
      });
      expect(projection.status).toBe('success');
      if (projection.status !== 'success') throw new Error('Expected migrated Provider model projection');
      const group = projection.groups.find((candidate) => candidate.connectionId === migratedConnectionId);
      const row = group?.rows.find((candidate) => candidate.ref.modelId === 'deepseek-v4-flash');
      expect(group).toBeDefined();
      expect(row?.compatibility).toMatchObject({
        result: { status: 'experimental' },
        confirmed: false,
      });
      if (!group || !row || row.compatibility.result.status !== 'experimental') {
        throw new Error('Expected review-required migrated DeepSeek compatibility');
      }
      const confirmation = await callEncryptedMachineRpc({
        ui,
        machineId: seeded.machineId,
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE,
        req: {
          machineId: seeded.machineId,
          action: 'confirmExperimental',
          connectionId: migratedConnectionId,
          expectedConnectionRevision: group.connectionRevision,
          agentTargetKey,
          modelId: row.compatibility.result.confirmationScope.kind === 'model'
            ? row.ref.modelId
            : null,
          compatibilityFingerprint: row.compatibility.compatibilityFingerprint,
        },
        secret,
        schema: DaemonProviderModelSettingsMutationResponseV1Schema,
        timeoutMs: 90_000,
      });
      expect(confirmation).toEqual({ status: 'success', action: 'confirmExperimental' });
    } finally {
      ui.close();
    }
    const confirmedSettings = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });

    const firstDaemonPid = firstDaemon.state.pid;
    await firstDaemon.stop();
    daemons = [];
    const restartedDaemon = await startTestDaemon({
      testDir: resolve(join(testDir, 'daemon-after-restart')),
      happyHomeDir: daemonHome,
      env: daemonEnv,
      startupTimeoutMs: 180_000,
      cliLaunchSpec,
    });
    daemons = [restartedDaemon];
    expect(restartedDaemon.state.pid).not.toBe(firstDaemonPid);

    const restartedReadback = await readEncryptedSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret,
    });
    const restartedProviderSettings =
      readProviderSettingsFromAccountSettingsV1(restartedReadback.settings).settings;
    expect(restartedProviderSettings.secretBindingsByConnectionId[migratedConnectionId]).toEqual({
      account: { apiKey: savedSecretId },
    });
    expect(restartedProviderSettings.migration?.completedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceProfileId: 'deepseek',
        kind: 'connection',
        connectionId: migratedConnectionId,
        modelSelection: {
          agentTargetKey: 'backend:claude',
          providerConnectionId: migratedConnectionId,
          modelId: 'deepseek-v4-flash',
        },
      }),
    ]));
    expect(restartedReadback.settings.unknownFutureKey)
      .toEqual(RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueTopLevel);
    expect(restartedReadback.settings.profiles).toEqual(expect.arrayContaining([
      RELEASED_CLI_V0_2_1_Q19_VECTOR.geminiApiKeyProfile,
      RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueFutureProfile,
    ]));
    expect((restartedReadback.settings.secretBindingsByProfileId as JsonRecord)['future-profile'])
      .toEqual(RELEASED_CLI_V0_2_1_Q19_VECTOR.opaqueProfileSidecar);
    const restartedProfileRead = readAiLaunchProfileCollection(restartedReadback.settings.profiles);
    const restartedGemini = restartedProfileRead.entries.find((entry) =>
      entry.kind === 'legacy' && entry.profile.id === 'gemini-api-key');
    expect(restartedGemini?.kind).toBe('legacy');
    if (restartedGemini?.kind !== 'legacy') {
      throw new Error('Expected released Gemini API-key Profile after daemon restart');
    }
    expect(restartedGemini.profile.environmentVariables).toEqual([]);
    expect(restartedProfileRead.raw).toEqual(expect.arrayContaining([
      RELEASED_CLI_V0_2_1_Q19_VECTOR.geminiApiKeyProfile,
    ]));

    const spawnResponse = await daemonControlPostJson<{
      success: boolean;
      sessionId?: string;
      error?: string;
      errorCode?: string;
    }>({
      port: restartedDaemon.state.httpPort,
      path: '/spawn-session',
      controlToken: restartedDaemon.state.controlToken,
      body: {
        directory: workspace,
        machineId: seeded.machineId,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        modelSelection: {
          v: 1,
          updatedAt: Date.now(),
          ref: {
            agentTargetKey,
            providerConnectionId: migratedConnectionId,
            modelId: 'deepseek-v4-flash',
          },
        },
      },
      timeoutMs: 300_000,
    });
    if (spawnResponse.status !== 200 || spawnResponse.data.success !== true) {
      throw new Error(
        `Expected migrated Provider daemon launch success (status=${spawnResponse.status}, errorCode=${String(spawnResponse.data.errorCode)}, error=${String(spawnResponse.data.error)})`,
      );
    }
    expect(spawnResponse.data).toMatchObject({ success: true, sessionId: expect.any(String) });
    const sessionId = spawnResponse.data.sessionId;
    if (!sessionId) throw new Error('Expected migrated Provider launch session id');

    const firstPrompt = `MIGRATED_PROVIDER_RESTART_LAUNCH_${run.runId}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: firstPrompt,
      requestedAction: { v: 1, kind: 'send_now' },
    });
    const invocation = await waitForFakeClaudeInvocation(
      fakeClaudeLogPath,
      (candidate) => candidate.invocationId === invocationId && candidate.mode === 'sdk',
      { timeoutMs: 120_000 },
    );
    const firstInvocationUserText = await waitForFakeClaudeUserText(
      fakeClaudeLogPath,
      (text) => text.includes(firstPrompt),
      { invocationId, timeoutMs: 120_000 },
    );
    expect(firstInvocationUserText.split(firstPrompt)).toHaveLength(2);
    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: 'FAKE_CLAUDE_OK_1',
      timeoutMs: 120_000,
    });
    const launchedModelValues = invocation.argv.flatMap((argument, index) =>
      argument === '--model' ? [invocation.argv[index + 1]] : []);
    expect(launchedModelValues).toEqual(['deepseek-v4-flash']);
    expect(invocation.environmentAttestation).toEqual({
      ANTHROPIC_BASE_URL: {
        present: true,
        sha256: sha256('https://api.deepseek.com/anthropic'),
        byteLength: Buffer.byteLength('https://api.deepseek.com/anthropic', 'utf8'),
      },
      ANTHROPIC_API_KEY: {
        present: true,
        sha256: sha256(providerSecret),
        byteLength: Buffer.byteLength(providerSecret, 'utf8'),
      },
      ANTHROPIC_AUTH_TOKEN: { present: false },
      CLAUDE_CODE_OAUTH_TOKEN: { present: false },
    });
    expect(invocation.environmentAttestation).not.toEqual(expect.objectContaining({
      ANTHROPIC_API_KEY: expect.objectContaining({ sha256: sha256(ambientNativeApiKey) }),
    }));

    await waitFor(async () => {
      const snapshot = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
      const metadata = decryptLegacyBase64(snapshot.metadata, secret) as JsonRecord | null;
      const intent = SessionModelSelectionIntentV1Schema.safeParse(metadata?.modelSelectionIntentV1);
      const selection = intent.success ? intent.data.selection : null;
      return selection !== null
        && selection.agentTargetKey === agentTargetKey
        && selection.providerConnectionId === migratedConnectionId
        && selection.modelId === 'deepseek-v4-flash';
    }, { timeoutMs: 120_000, context: 'migrated Provider launch session intent persistence' });

    const afterLaunch = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });
    expect(afterLaunch.version).toBe(confirmedSettings.version);
    expect(afterLaunch.settings).toEqual(confirmedSettings.settings);
    const afterLaunchProviderSettings =
      readProviderSettingsFromAccountSettingsV1(afterLaunch.settings).settings;
    expect(afterLaunchProviderSettings.secretBindingsByConnectionId[migratedConnectionId]).toEqual({
      account: { apiKey: savedSecretId },
    });

    await restartedDaemon.stop();
    daemons = [];
    const evidenceCorpus = (await readTextEvidenceFiles(testDir)).join('\n');
    expect(evidenceCorpus).not.toContain(providerSecret);
    expect(evidenceCorpus).not.toContain(ambientNativeApiKey);
    expect(evidenceCorpus).not.toContain(ambientNativeOauthToken);
    expect(JSON.stringify(spawnResponse.data)).not.toContain(providerSecret);
    expect(JSON.stringify(spawnResponse.data)).not.toContain(ambientNativeApiKey);
    expect(JSON.stringify(spawnResponse.data)).not.toContain(ambientNativeOauthToken);
  }, 600_000);

  it('persists a redacted conflict and applies keep-existing without losing the migrated favorite', async () => {
    const testDir = run.testDir(`providers-legacy-conflict-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    const secret = Uint8Array.from(randomBytes(32));
    const contributionKey = 'happier.provider.deepseek/deepseek';
    const existingConnectionId = ProviderConnectionIdSchema.parse('pc_existing_deepseek');
    const seedSettings = {
      schemaVersion: 7,
      secrets: [
        {
          id: 'secret-existing', name: 'Existing key', kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'ZXhpc3Rpbmc=' } },
          createdAt: 1, updatedAt: 1,
        },
        {
          id: 'secret-legacy', name: 'Legacy key', kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'bGVnYWN5' } },
          createdAt: 2, updatedAt: 2,
        },
      ],
      secretBindingsByProfileId: {
        deepseek: { DEEPSEEK_AUTH_TOKEN: 'secret-legacy' },
      },
      favoriteProfiles: ['deepseek'],
      profileEnabledById: { deepseek: true },
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
          v: 1,
          id: existingConnectionId,
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: 'DeepSeek',
          displayNameMode: 'automatic',
          revision: 0,
          createdAt: 1,
          updatedAt: 1,
        }],
        secretBindingsByConnectionId: {
          [existingConnectionId]: { account: { apiKey: 'secret-existing' } },
        },
      },
      unknownConflictFixture: { preserved: true },
    } as const;
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret,
      settings: seedSettings,
    });

    const daemonHome = resolve(join(testDir, 'daemon'));
    await mkdir(daemonHome, { recursive: true });
    const seeded = await seedCliAuthForServer({
      cliHome: daemonHome,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });
    daemons = [await startTestDaemon({
      testDir: resolve(join(testDir, 'daemon-runtime')),
      happyHomeDir: daemonHome,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHome,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
      startupTimeoutMs: 180_000,
      cliLaunchSpec,
    })];

    let conflictFingerprint = '';
    await waitFor(async () => {
      const current = await readEncryptedSettings({ baseUrl: server!.baseUrl, token: auth.token, secret });
      const providerSettings = readProviderSettingsFromAccountSettingsV1(current.settings).settings;
      const conflict = providerSettings.migration?.pendingConflicts.find(
        (entry) => entry.sourceProfileId === 'deepseek',
      );
      if (!conflict) return false;
      conflictFingerprint = conflict.candidateFingerprint;
      expect(conflict).toMatchObject({
        contributionKey: canonicalizeProviderContributionKeyV1(contributionKey),
        existingConnectionId,
        kinds: ['credential_binding'],
      });
      expect(JSON.stringify(conflict)).not.toContain('secret-existing');
      expect(JSON.stringify(conflict)).not.toContain('secret-legacy');
      expect(providerSettings.migration?.completedSources).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceProfileId: 'deepseek' }),
      ]));
      expect(providerSettings.secretBindingsByConnectionId[existingConnectionId]).toEqual({
        account: { apiKey: 'secret-existing' },
      });
      expect((current.settings.secretBindingsByProfileId as JsonRecord).deepseek).toEqual({
        DEEPSEEK_AUTH_TOKEN: 'secret-legacy',
      });
      return true;
    }, { timeoutMs: 180_000, context: 'legacy provider migration conflict persistence' });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(async () => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'provider conflict UI socket connection',
      });
      const resolved = await callEncryptedMachineRpc({
        ui,
        machineId: seeded.machineId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM,
        req: {
          machineId: seeded.machineId,
          sourceProfileId: 'deepseek',
          expectedCandidateFingerprint: conflictFingerprint,
          decision: { kind: 'keep_existing', existingConnectionId },
        },
        secret,
        schema: DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
        timeoutMs: 120_000,
      });
      expect(resolved).toMatchObject({
        status: 'success',
        sourceProfileId: 'deepseek',
        connectionId: existingConnectionId,
      });
    } finally {
      ui.close();
    }

    const final = await readEncryptedSettings({ baseUrl: server.baseUrl, token: auth.token, secret });
    const providerSettings = readProviderSettingsFromAccountSettingsV1(final.settings).settings;
    expect(providerSettings.connections).toEqual([
      expect.objectContaining({ id: existingConnectionId }),
    ]);
    expect(providerSettings.secretBindingsByConnectionId[existingConnectionId]).toEqual({
      account: { apiKey: 'secret-existing' },
    });
    expect(providerSettings.migration?.pendingConflicts).toEqual([]);
    expect(providerSettings.migration?.completedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceProfileId: 'deepseek',
        kind: 'connection',
        connectionId: existingConnectionId,
        sourceRevision: 2,
        modelSelectionOrigin: 'implicit_default',
        modelSelection: expect.objectContaining({
          providerConnectionId: existingConnectionId,
          modelId: 'deepseek-v4-flash',
        }),
      }),
    ]));
    expect((final.settings.secretBindingsByProfileId as JsonRecord).deepseek).toBeUndefined();
    expect(final.settings.favoriteProfiles).toEqual([]);
    expect(final.settings.favoriteModelSelectionsV1).toEqual([
      expect.objectContaining({
        selection: expect.objectContaining({
          ref: expect.objectContaining({
            providerConnectionId: existingConnectionId,
            modelId: 'deepseek-v4-flash',
          }),
        }),
      }),
    ]);
    expect(final.settings.secrets).toEqual(seedSettings.secrets);
    expect(final.settings.unknownConflictFixture).toEqual({ preserved: true });
  }, 360_000);
});
