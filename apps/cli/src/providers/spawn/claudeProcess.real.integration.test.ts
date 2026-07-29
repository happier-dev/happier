import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProviderConnectionIdSchema,
  ProviderCredentialTransportV1Schema,
  AgentProviderBindingMaterializationV1Schema,
  createProviderErrorV1,
  type AgentProviderBindingMaterializationV1,
} from '@happier-dev/protocol';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1 } from '@happier-dev/plugins-claude/agent';
import { buildSpawnChildProcessEnv } from '@/daemon/spawn/buildSpawnChildProcessEnv';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';

import { createProviderSpawnAuthorizationAttempt } from './authorize';
import { createProviderRedactionLease } from './redaction';
import type { ProviderSpawnAuthorization } from './resolve';

const connectionId = ProviderConnectionIdSchema.parse('pc_real_claude_fixture');
const bearerTransport = ProviderCredentialTransportV1Schema.parse({
  id: 'anthropic-bearer',
  protocols: ['anthropic'],
  uses: ['runtime'],
  destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function authorization(): Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'external' } }
> {
  return {
    deployment: { kind: 'external' },
    ticket: {
      connectionId,
      connectionRevision: 1,
      machineId: 'machine-real-fixture',
      connectionSecurityFingerprint: 'connection-security:v1:fixture',
      bindingSecurityFingerprint: 'binding-security:v1:fixture',
      grantFingerprint: 'account-grant:v1:fixture',
      selectedSecretBindingId: 'secret-real-fixture',
      selectedSecretRecordFingerprint: 'saved-secret-record:v1:fixture',
    },
    bindingSecurityFingerprint: 'binding-security:v1:fixture',
    observationAuthorizationFingerprint: 'observation-authorization:v1:fixture',
    binding: {
      v: 1,
      agentTargetKey: 'backend:claude:built_in',
      selection: {
        connectionId,
        model: { id: 'fixture-sonnet', name: 'Fixture Sonnet' },
      },
      contributionKey: 'happier.provider.fixture/anthropic-gateway',
      endpoint: {
        endpointTemplateId: 'anthropic-messages',
        normalizedUrl: 'https://gateway.example.test/anthropic',
        protocol: 'anthropic',
        publicHeaders: { 'x-happier-fixture': 'public-fixture-header' },
      },
      runtimeCredentialTransport: bearerTransport,
      compatibilityFingerprint: 'compatibility:v1:fixture',
    },
    prepared: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare(),
    support: {
      acceptsProtocols: ['anthropic'],
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [{
          protocol: 'anthropic',
          destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] },
        }],
      },
      authIsolation: {
        suppressConnectedServiceIds: ['claude-subscription', 'anthropic'],
        ownedEnvKeys: [
          'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
          'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_SETUP_TOKEN',
        ],
      },
      materialization: 'spawnEnv',
      applyPolicy: 'live',
      supportsFreeformModelIds: true,
    },
    adapterVersion: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
    credentialReference: {
      kind: 'apiKey',
      secretId: 'secret-real-fixture',
      secretRecordFingerprint: 'saved-secret-record:v1:fixture',
    },
    sessionBindingMetadata: {
      v: 1,
      connectionId,
      contributionKey: 'happier.provider.fixture/anthropic-gateway',
      connectionRevision: 1,
      model: { id: 'fixture-sonnet', name: 'Fixture Sonnet' },
      protocol: 'anthropic',
      materialization: 'spawnEnv',
      compatibilityFingerprint: 'compatibility:v1:fixture',
      bindingSecurityFingerprint: 'binding-security:v1:fixture',
      displaySnapshot: {
        providerName: 'Fixture Anthropic gateway',
        connectionName: 'Fixture Anthropic gateway',
        connectionRole: 'named',
        connectionDisplayNameMode: 'custom',
      },
    },
  };
}

async function runFakeClaude(input: Readonly<{
  env: NodeJS.ProcessEnv;
  logPath: string;
}>): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const fixturePath = resolve(
    import.meta.dirname,
    '../../../../../packages/tests/src/fixtures/fake-claude-code-cli.js',
  );
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      fixturePath,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
    ], {
      cwd: import.meta.dirname,
      env: {
        ...input.env,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: input.logPath,
        HAPPIER_E2E_FAKE_CLAUDE_CAPTURE_ENV_KEYS: [
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_CUSTOM_HEADERS',
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN',
          'CLAUDE_CODE_OAUTH_TOKEN',
        ].join(','),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`fake Claude exited code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end();
  });
}

function readInvocation(raw: string): Record<string, unknown> {
  const entries = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const invocation = entries.find((entry) => entry.type === 'invocation');
  if (!invocation) throw new Error('Missing fake Claude invocation');
  return invocation;
}

describe('real Claude fixture provider spawn environment isolation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('scopes the provider endpoint, credential, and public headers to one real child and leaves the next child clean', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'happier-real-claude-provider-'));
    roots.push(root);
    const providerLog = resolve(root, 'provider.jsonl');
    const nativeLog = resolve(root, 'native.jsonl');
    const secret = 'odd key :: line-one\nline-two ?&=% ☃';
    const daemonEnv = {
      PATH: process.env.PATH,
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_CUSTOM_HEADERS: 'x-native-fixture: inherited',
      ANTHROPIC_API_KEY: 'ambient-native-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-native-oauth-token',
    };
    const daemonEnvBefore = { ...daemonEnv };
    const parentBefore = {
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
      customHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS,
    };
    let redactionClosed = 0;

    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: async () => ({ ok: true as const, authorization: authorization() }),
      resolveCredential: () => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: secret } }),
      materialize: async ({ authorization: current, credential }): Promise<AgentProviderBindingMaterializationV1> =>
        AgentProviderBindingMaterializationV1Schema.parse(
          await CLAUDE_PROVIDER_BINDING_ADAPTER_V1.materialize({
            v: 1,
            binding: current.binding,
            prepared: current.prepared,
            credential,
          }),
        ),
      materializationBaseDir: resolve(root, 'materialized'),
      sessionId: 'session-real-fixture',
      createRedactionLease: ({ values }) => createProviderRedactionLease({
        values,
        onClose: () => { redactionClosed += 1; },
      }),
    });

    const composed = await resolveSpawnChildEnvironment({
      options: { directory: root },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: daemonEnv,
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      materializeProviderBindingAfterHooks: async () => {
        const result = await attempt.materializeAfterHooks();
        if (!result.ok) {
          return { ok: false as const, errorCode: 'SPAWN_VALIDATION_FAILED' as const, errorMessage: result.error.code };
        }
        return {
          ok: true as const,
          providerEnvironmentOverlay: result.materialization.providerEnvironmentOverlay,
          providerBindingLaunchHandoff: {
            v: 1 as const,
            materialization: result.materialization.launchMaterialization,
            sessionBindingMetadata: attempt.authorization.sessionBindingMetadata,
          },
        };
      },
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) throw new Error(composed.errorMessage);
    expect(await attempt.revalidateBeforeCommit()).toEqual({ ok: true });
    const cleanupOnExit = attempt.takeCleanupOnExit();

    const providerEnv = buildSpawnChildProcessEnv({
      processEnv: daemonEnv,
      extraEnv: composed.extraEnvForChild,
      unsetEnvKeys: composed.unsetEnvKeys,
    });
    const providerRun = await runFakeClaude({ env: providerEnv, logPath: providerLog });
    cleanupOnExit?.();
    cleanupOnExit?.();

    const providerRaw = await readFile(providerLog, 'utf8');
    const providerInvocation = readInvocation(providerRaw);
    const providerAttestation = providerInvocation.environmentAttestation as Record<string, { present: boolean; sha256?: string }>;
    expect(providerAttestation.ANTHROPIC_BASE_URL).toEqual({
      present: true,
      sha256: sha256('https://gateway.example.test/anthropic'),
      byteLength: Buffer.byteLength('https://gateway.example.test/anthropic', 'utf8'),
    });
    expect(providerAttestation.ANTHROPIC_CUSTOM_HEADERS?.sha256)
      .toBe(sha256('x-happier-fixture: public-fixture-header'));
    expect(providerAttestation.ANTHROPIC_AUTH_TOKEN?.sha256).toBe(sha256(secret));
    expect(providerAttestation.ANTHROPIC_API_KEY).toEqual({ present: false });
    expect(providerAttestation.CLAUDE_CODE_OAUTH_TOKEN).toEqual({ present: false });
    expect(`${providerRaw}\n${providerRun.stdout}\n${providerRun.stderr}`).not.toContain(secret);
    expect(redactionClosed).toBe(1);

    expect(process.env.ANTHROPIC_BASE_URL).toBe(parentBefore.baseUrl);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(parentBefore.authToken);
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(parentBefore.customHeaders);
    expect(daemonEnv).toEqual(daemonEnvBefore);

    const nativeEnv = buildSpawnChildProcessEnv({
      processEnv: daemonEnv,
      extraEnv: {},
    });
    await runFakeClaude({ env: nativeEnv, logPath: nativeLog });
    const nativeRaw = await readFile(nativeLog, 'utf8');
    const nativeAttestation = readInvocation(nativeRaw)
      .environmentAttestation as Record<string, { present: boolean }>;
    expect(nativeAttestation.ANTHROPIC_BASE_URL).toMatchObject({
      present: true,
      sha256: sha256('https://api.anthropic.com'),
    });
    expect(nativeAttestation.ANTHROPIC_CUSTOM_HEADERS).toMatchObject({
      present: true,
      sha256: sha256('x-native-fixture: inherited'),
    });
    expect(nativeAttestation.ANTHROPIC_API_KEY).toMatchObject({
      present: true,
      sha256: sha256('ambient-native-api-key'),
    });
    expect(nativeAttestation.ANTHROPIC_AUTH_TOKEN).toEqual({ present: false });
    expect(nativeAttestation.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject({
      present: true,
      sha256: sha256('ambient-native-oauth-token'),
    });
    expect(nativeRaw).not.toContain(secret);
    expect(daemonEnv).toEqual(daemonEnvBefore);
  });

  it('does not create a child or materialization when provider authorization is refused', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'happier-real-claude-refusal-'));
    roots.push(root);
    const logPath = resolve(root, 'refused.jsonl');
    let materializeCalls = 0;
    const refusal = createProviderErrorV1('provider_authorization_changed', {
      connectionId,
      machineId: 'machine-real-fixture',
    });
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: async () => ({ ok: false as const, error: refusal }),
      resolveCredential: () => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'must-not-resolve' } }),
      materialize: async (): Promise<AgentProviderBindingMaterializationV1> => {
        materializeCalls += 1;
        return { v: 1, kind: 'spawnEnv', env: [] };
      },
      materializationBaseDir: resolve(root, 'materialized'),
      sessionId: 'session-refused-fixture',
    });

    await expect(attempt.materializeAfterHooks()).resolves.toEqual({ ok: false, error: refusal });
    expect(materializeCalls).toBe(0);
    await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(resolve(root, 'materialized'))).rejects.toMatchObject({ code: 'ENOENT' });
    attempt.cleanupOnFailure();
  });
});
