import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  buildBackendTargetKeyV2,
  deriveSettingsSecretsKeyV1,
  openAccountScopedBlobCiphertext,
  readProviderSettingsFromAccountSettingsV1,
  sealSecretsDeepV1,
  type AccountSettingsStoredContentEnvelope,
  type ProviderConnectionId,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  runCliJson,
  writeRedactedResultArtifact,
  type JsonEnvelope,
} from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'core' });
const OPENROUTER_CANONICAL_CONTRIBUTION_KEY = 'happier.provider.openrouter/openrouter';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as JsonRecord;
}

function readConnectionId(envelope: JsonEnvelope): ProviderConnectionId {
  const connectionId = asRecord(envelope.data).connectionId;
  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    throw new Error(`Expected a connection id in ${JSON.stringify(envelope)}`);
  }
  return ProviderConnectionIdSchema.parse(connectionId);
}

async function writeAgentLaunchSentinelExecutable(params: Readonly<{
  directory: string;
}>): Promise<string> {
  const executablePath = resolve(join(
    params.directory,
    process.platform === 'win32' ? 'opencode-launch-sentinel.cmd' : 'opencode-launch-sentinel',
  ));
  const contents = process.platform === 'win32'
    ? '@echo off\r\n>>"%HAPPIER_E2E_AGENT_LAUNCH_SENTINEL%" echo launched\r\nexit /b 86\r\n'
    : '#!/bin/sh\nprintf \'%s\\n\' launched >> "$HAPPIER_E2E_AGENT_LAUNCH_SENTINEL"\nexit 86\n';
  await writeFile(executablePath, contents, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(executablePath, 0o755);
  }
  return executablePath;
}

async function readAccountSettings(params: Readonly<{
  baseUrl: string;
  token: string;
  secret: Uint8Array;
}>): Promise<JsonRecord> {
  const response = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  expect(response.status).toBe(200);
  const row = asRecord(response.data);
  const content = row.content as AccountSettingsStoredContentEnvelope | null;
  if (!content || content.t !== 'encrypted') throw new Error('Expected encrypted account settings');
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material: { type: 'legacy', secret: params.secret },
    ciphertext: content.c,
  });
  return asRecord(opened?.value);
}

describe('core e2e: terminal-only Provider authoring', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  }, 120_000);

  it('manages built-in and custom connections, grants, SavedSecrets, models, probes, and removal through the real CLI', async () => {
    const testDir = run.testDir(`providers-cli-authoring-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });
    const auth = await createTestAuth(server.baseUrl);
    const cliHome = resolve(join(testDir, 'cli-home'));
    await mkdir(cliHome, { recursive: true });

    const accountSecret = Uint8Array.from(randomBytes(32));
    const { machineId } = await seedCliAuthForServer({
      cliHome,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret: accountSecret,
    });

    const savedSecretId = `secret_${randomUUID()}`;
    const replacementSavedSecretId = `secret_${randomUUID()}`;
    const plaintextSecret = `provider-e2e-secret-${randomUUID()}`;
    const replacementPlaintextSecret = `provider-e2e-replacement-${randomUUID()}`;
    const now = Date.now();
    const seededSettings = sealSecretsDeepV1({
      schemaVersion: 7,
      providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1,
      secrets: [{
        id: savedSecretId,
        name: 'Provider E2E API key',
        kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: plaintextSecret },
        createdAt: now,
        updatedAt: now,
      }, {
        id: replacementSavedSecretId,
        name: 'Provider E2E replacement API key',
        kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: replacementPlaintextSecret },
        createdAt: now,
        updatedAt: now,
      }],
    }, deriveSettingsSecretsKeyV1(accountSecret), (length) => Uint8Array.from(randomBytes(length)));
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret: accountSecret,
      settings: seededSettings,
    });

    const runProviderCli = async (label: string, args: string[]): Promise<JsonEnvelope> => await runCliJson({
      testDir,
      cliHomeDir: cliHome,
      serverUrl: server!.baseUrl,
      webappUrl: server!.baseUrl,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
      },
      label,
      args: ['providers', ...args, '--json'],
      timeoutMs: 120_000,
      launchOptions: {
        preferSourceEntrypoint: true,
        skipSourceFreshnessCheck: true,
        skipSharedDepsBuild: true,
      },
    });

    const custom = await runProviderCli('providers.add.custom', [
      'add', '--custom', '--name', 'Company gateway', '--protocol', 'openai-responses',
      '--base-url', 'http://127.0.0.1:11434/v1', '--catalog', 'manual',
      '--credential-style', 'bearer', '--saved-secret-id', savedSecretId,
    ]);
    expect(custom).toMatchObject({ ok: true, kind: 'providers_add' });
    const customConnectionId = readConnectionId(custom);

    const builtIn = await runProviderCli('providers.add.openrouter', [
      'add', OPENROUTER_CANONICAL_CONTRIBUTION_KEY, '--saved-secret-id', savedSecretId,
    ]);
    expect(builtIn).toMatchObject({
      ok: true,
      kind: 'providers_add',
      data: { contributionKey: OPENROUTER_CANONICAL_CONTRIBUTION_KEY, created: true },
    });
    const builtInConnectionId = readConnectionId(builtIn);

    const shown = await runProviderCli('providers.show.custom', ['show', customConnectionId]);
    expect(shown).toMatchObject({
      ok: true,
      kind: 'providers_show',
      data: { connectionId: customConnectionId, contributionKey: null, name: 'Company gateway' },
    });
    expect(JSON.stringify(shown)).not.toContain(savedSecretId);

    const edited = await runProviderCli('providers.edit.custom', [
      'edit', customConnectionId, '--name', 'Company gateway renamed',
    ]);
    expect(edited).toMatchObject({
      ok: true,
      kind: 'providers_edit',
      data: { connectionId: customConnectionId, name: 'Company gateway renamed' },
    });

    const enabled = await runProviderCli('providers.enable.custom', ['enable', customConnectionId]);
    expect(enabled).toMatchObject({
      ok: true,
      kind: 'providers_enable',
      data: { connectionId: customConnectionId, scope: 'machine' },
    });
    const disabled = await runProviderCli('providers.disable.custom', ['disable', customConnectionId]);
    expect(disabled).toMatchObject({
      ok: true,
      kind: 'providers_disable',
      data: { connectionId: customConnectionId, scope: 'connection' },
    });
    const reenabled = await runProviderCli('providers.reenable.custom', ['enable', customConnectionId]);
    expect(reenabled).toMatchObject({
      ok: true,
      kind: 'providers_enable',
      data: { connectionId: customConnectionId, scope: 'machine' },
    });

    await expect(runProviderCli('providers.bind-secret.custom', [
      'bind-secret', customConnectionId, '--scope', 'account', '--saved-secret-id', replacementSavedSecretId,
    ])).resolves.toMatchObject({ ok: true, kind: 'providers_bind_secret' });
    await expect(runProviderCli('providers.unbind-secret.custom', [
      'unbind-secret', customConnectionId, '--scope', 'account',
    ])).resolves.toMatchObject({ ok: true, kind: 'providers_unbind_secret' });
    await expect(runProviderCli('providers.rebind-secret.custom', [
      'bind-secret', customConnectionId, '--scope', 'account', '--saved-secret-id', savedSecretId,
    ])).resolves.toMatchObject({ ok: true, kind: 'providers_bind_secret' });

    const addModel = await runProviderCli('providers.add-model', [
      'add-model', customConnectionId, '--models', 'Model-A\norg/model.b\nModel-A',
    ]);
    expect(addModel).toMatchObject({
      ok: true,
      kind: 'providers_add_model',
      data: { accepted: ['Model-A', 'org/model.b'], rejected: [] },
    });
    const models = await runProviderCli('providers.models.custom', ['models', customConnectionId]);
    expect(models).toMatchObject({
      ok: true,
      kind: 'providers_models',
      data: {
        connectionId: customConnectionId,
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'Model-A', source: 'manual' }),
          expect.objectContaining({ id: 'org/model.b', source: 'manual' }),
        ]),
      },
    });
    await expect(runProviderCli('providers.remove-model.custom', [
      'remove-model', customConnectionId, '--model', 'Model-A',
    ])).resolves.toMatchObject({ ok: true, kind: 'providers_remove_model' });
    await expect(runProviderCli('providers.readd-model.custom', [
      'add-model', customConnectionId, '--models', 'Model-A',
    ])).resolves.toMatchObject({ ok: true, kind: 'providers_add_model' });

    const probe = await runProviderCli('providers.probe.custom', ['probe', customConnectionId]);
    const test = await runProviderCli('providers.test.custom', ['test', customConnectionId]);
    expect(probe).toMatchObject({ ok: true, kind: 'providers_probe' });
    expect(test).toMatchObject({ ok: true, kind: 'providers_test' });
    expect(JSON.stringify(custom)).not.toContain(plaintextSecret);
    expect(JSON.stringify(builtIn)).not.toContain(plaintextSecret);
    expect(JSON.stringify(addModel)).not.toContain(plaintextSecret);
    expect(JSON.stringify(addModel)).not.toContain(savedSecretId);
    expect(JSON.stringify([probe, test])).not.toContain(plaintextSecret);
    expect(JSON.stringify([probe, test])).not.toContain(replacementPlaintextSecret);

    const raw = await readAccountSettings({ baseUrl: server.baseUrl, token: auth.token, secret: accountSecret });
    const providerSettings = readProviderSettingsFromAccountSettingsV1(raw).settings;
    expect(providerSettings.connections).toHaveLength(2);
    expect(providerSettings.secretBindingsByConnectionId[customConnectionId]?.account).toEqual({
      apiKey: savedSecretId,
    });
    expect(providerSettings.secretBindingsByConnectionId[builtInConnectionId]?.account).toEqual({
      apiKey: savedSecretId,
    });
    expect(providerSettings.accountGrants).toEqual([]);
    expect(providerSettings.machineGrants).toEqual([
      expect.objectContaining({
        connectionId: customConnectionId,
        machineId,
        connectionSecurityFingerprint: expect.any(String),
        endpointSetFingerprint: expect.any(String),
      }),
    ]);
    expect(providerSettings.manualModelsByConnectionId[customConnectionId]).toEqual([
      expect.objectContaining({ id: 'org/model.b', addedAt: expect.any(Number) }),
      expect.objectContaining({ id: 'Model-A', addedAt: expect.any(Number) }),
    ]);

    await expect(runProviderCli('providers.remove.custom', ['remove', customConnectionId]))
      .resolves.toMatchObject({ ok: true, kind: 'providers_remove' });
    const listed = await runProviderCli('providers.list.after-remove', ['list', '--available']);
    expect(listed).toMatchObject({
      ok: true,
      kind: 'providers_list',
      data: {
        connections: [expect.objectContaining({
          connectionId: builtInConnectionId,
          contributionKey: OPENROUTER_CANONICAL_CONTRIBUTION_KEY,
        })],
      },
    });
  }, 480_000);

  it('persists two same-contribution connections and exposes both identities through real CLI edit/list', async () => {
    const testDir = run.testDir(`providers-cli-multi-connection-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });
    const auth = await createTestAuth(server.baseUrl);
    const cliHome = resolve(join(testDir, 'cli-home'));
    await mkdir(cliHome, { recursive: true });

    const accountSecret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret: accountSecret,
    });
    const savedSecretId = `secret_${randomUUID()}`;
    const plaintextSecret = `provider-e2e-secret-${randomUUID()}`;
    const now = Date.now();
    const seededSettings = sealSecretsDeepV1({
      schemaVersion: 7,
      providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1,
      secrets: [{
        id: savedSecretId,
        name: 'OpenRouter E2E API key',
        kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: plaintextSecret },
        createdAt: now,
        updatedAt: now,
      }],
    }, deriveSettingsSecretsKeyV1(accountSecret), (length) => Uint8Array.from(randomBytes(length)));
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret: accountSecret,
      settings: seededSettings,
    });

    const runProviderCli = async (label: string, args: string[]): Promise<JsonEnvelope> => await runCliJson({
      testDir,
      cliHomeDir: cliHome,
      serverUrl: server!.baseUrl,
      webappUrl: server!.baseUrl,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
      },
      label,
      args: ['providers', ...args, '--json'],
      timeoutMs: 120_000,
      launchOptions: {
        preferSourceEntrypoint: true,
        skipSourceFreshnessCheck: true,
        skipSharedDepsBuild: true,
      },
    });

    const defaultOpenRouter = await runProviderCli('providers.add.openrouter.default', [
      'add', OPENROUTER_CANONICAL_CONTRIBUTION_KEY, '--saved-secret-id', savedSecretId,
    ]);
    const namedOpenRouter = await runProviderCli('providers.add.openrouter.work', [
      'add', OPENROUTER_CANONICAL_CONTRIBUTION_KEY, '--name', 'Work OpenRouter', '--saved-secret-id', savedSecretId,
    ]);
    expect(defaultOpenRouter).toMatchObject({ ok: true, kind: 'providers_add' });
    expect(namedOpenRouter).toMatchObject({ ok: true, kind: 'providers_add' });
    const defaultConnectionId = readConnectionId(defaultOpenRouter);
    const namedConnectionId = readConnectionId(namedOpenRouter);
    expect(namedConnectionId).not.toBe(defaultConnectionId);
    expect(JSON.stringify([defaultOpenRouter, namedOpenRouter])).not.toContain(savedSecretId);
    expect(JSON.stringify([defaultOpenRouter, namedOpenRouter])).not.toContain(plaintextSecret);

    const edited = await runProviderCli('providers.edit', [
      'edit', namedConnectionId, '--name', 'Company OpenRouter',
    ]);
    expect(edited).toMatchObject({ ok: true, kind: 'providers_edit', data: { name: 'Company OpenRouter' } });

    const listed = await runProviderCli('providers.list', ['list', '--available']);
    expect(listed).toMatchObject({
      ok: true,
      kind: 'providers_list',
      data: {
        connections: expect.arrayContaining([
          expect.objectContaining({ connectionId: defaultConnectionId, contributionKey: OPENROUTER_CANONICAL_CONTRIBUTION_KEY, role: 'default' }),
          expect.objectContaining({ connectionId: namedConnectionId, contributionKey: OPENROUTER_CANONICAL_CONTRIBUTION_KEY, name: 'Company OpenRouter', role: 'named' }),
        ]),
      },
    });

    const raw = await readAccountSettings({ baseUrl: server.baseUrl, token: auth.token, secret: accountSecret });
    const providerSettings = readProviderSettingsFromAccountSettingsV1(raw).settings;
    expect(providerSettings.connections.map((connection) => connection.id)).toEqual(
      expect.arrayContaining([defaultConnectionId, namedConnectionId]),
    );
  }, 600_000);

  it('carries structured Provider selection into the real daemon and refuses a missing binding without native fallback', async () => {
    const testDir = run.testDir(`providers-daemon-no-fallback-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });
    const auth = await createTestAuth(server.baseUrl);
    const daemonHome = resolve(join(testDir, 'daemon-home'));
    const workspace = resolve(join(testDir, 'workspace'));
    await Promise.all([mkdir(daemonHome, { recursive: true }), mkdir(workspace, { recursive: true })]);

    const accountSecret = Uint8Array.from(randomBytes(32));
    const { machineId } = await seedCliAuthForServer({
      cliHome: daemonHome,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret: accountSecret,
    });
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret: accountSecret,
      settings: { schemaVersion: 7, providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 },
    });

    const agentLaunchSentinel = resolve(join(testDir, 'agent-launched.log'));
    const agentExecutable = await writeAgentLaunchSentinelExecutable({
      directory: testDir,
    });
    const nativeCredential = `native-fallback-must-not-run-${randomUUID()}`;
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_OPENCODE_PATH: agentExecutable,
      HAPPIER_E2E_AGENT_LAUNCH_SENTINEL: agentLaunchSentinel,
      OPENAI_API_KEY: nativeCredential,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHome, env: daemonEnv });

    const backendTarget = { kind: 'builtInAgent' as const, agentId: 'opencode' };
    const response = await daemonControlPostJson<{
      success: boolean;
      errorCode?: string;
      error?: string;
    }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspace,
        machineId,
        backendTarget,
        terminal: { mode: 'plain' },
        environmentVariables: daemonEnv,
        modelSelection: {
          v: 1,
          updatedAt: Date.now(),
          ref: {
            agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'opencode' }),
            providerConnectionId: 'pc_missing_e2e',
            modelId: 'provider-model-e2e',
          },
        },
      },
      timeoutMs: 90_000,
    });

    const responseText = JSON.stringify(response.data);
    const nativeCredentialAbsent = !responseText.includes(nativeCredential);
    const agentLaunchSentinelAbsent = await stat(agentLaunchSentinel).then(
      () => false,
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    await writeRedactedResultArtifact({
      testDir,
      artifactName: 'provider-daemon-missing-binding.result.json',
      label: 'provider-daemon-missing-binding',
      outcome: {
        httpStatus: response.status,
        success: response.data.success,
        error: response.data.error === 'provider_connection_not_found'
          ? 'provider_connection_not_found'
          : 'unexpected',
        errorCode: response.data.errorCode === 'SPAWN_VALIDATION_FAILED'
          ? 'SPAWN_VALIDATION_FAILED'
          : 'unexpected',
        nativeCredentialAbsent,
        agentLaunchSentinelAbsent,
      },
    });

    expect(response.status).toBe(500);
    expect(response.data.success).toBe(false);
    expect(response.data).toMatchObject({
      error: 'provider_connection_not_found',
      errorCode: 'SPAWN_VALIDATION_FAILED',
    });
    expect(nativeCredentialAbsent).toBe(true);
    expect(agentLaunchSentinelAbsent).toBe(true);
  }, 600_000);
});
