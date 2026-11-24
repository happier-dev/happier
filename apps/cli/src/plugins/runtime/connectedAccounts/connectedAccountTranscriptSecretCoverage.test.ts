import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createConnectedAccountCredentialRedaction } from '@happier-dev/cli-common/connectedAccounts';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { saveCredential as saveXaiCredential } from '../../../../../../packages/plugins/grok/src/connectedAccounts/portableRuntime';
import { geminiConnectedAccountRuntime } from '../../../../../../packages/plugins/gemini/src/connectedAccounts/runtime';
import { stageCodeRabbitNativeAuth } from '../../../../../../packages/plugins/review-coderabbit/src/connectedAccount';

/**
 * Every bundled Connected Account that an Agent Session receives (environment or files) must
 * register what it delivers with the Session transcript redactor: a secret the runtime writes
 * into the Session's env or home is masked when the Agent prints it. Stored shapes are what each
 * runtime writes and reads; the collector is the real host classification over the real descriptor.
 */
const PLUGINS_ROOT = join(__dirname, '../../../../../../packages/plugins');
const fake = (name: string) => `fake-secret-${name}`;
const future = String(Date.UTC(2100, 0, 1));
const jwt = (name: string) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: 4102444800, sub: name })).toString('base64url')}.${fake(name)}`;

type StoredShape = Readonly<Record<string, string>>;

/** The stored credential a mode's writer leaves, by `<pluginId>/<serviceId>` and mode id. */
async function storedShapes(): Promise<
  Readonly<Record<string, Readonly<Record<string, StoredShape>>>>
> {
  const recordingStore = (values: Record<string, string>) => ({
    async get(key: string) { return values[key] ?? null; },
    async set(key: string, value: string) { values[key] = value; },
    async delete(key: string) { delete values[key]; },
  });
  // The service-account mode's own writer, from the JSON a person pastes.
  const geminiServiceAccount = async () => {
    const values: Record<string, string> = {};
    const mode = geminiConnectedAccountRuntime.authentication.modes['service-account'];
    if (mode?.kind !== 'manual') throw new Error('Expected the Gemini service-account mode');
    await mode.complete({ fields: { credentialsJson: JSON.stringify({ type: 'service_account', project_id: 'project',
      private_key_id: 'key-1', private_key: `-----BEGIN PRIVATE KEY-----\n${fake('gemini-private-key')}\n-----END PRIVATE KEY-----\n`,
      client_email: 'agent@project.iam.gserviceaccount.com', client_id: '1' }) } },
    { attemptCredentials: recordingStore(values) } as unknown as Parameters<typeof mode.complete>[1]);
    return values;
  };
  // CodeRabbit's login staging over a login file holding a token field.
  const codeRabbitLogin = async () => {
    const values: Record<string, string> = {};
    await stageCodeRabbitNativeAuth(recordingStore(values) as unknown as Parameters<typeof stageCodeRabbitNativeAuth>[0],
      new TextEncoder().encode(JSON.stringify({ session: { accessToken: fake('coderabbit'), expiresAt: 4102444800 } })));
    return values;
  };
  const xai = async (credential: Parameters<typeof saveXaiCredential>[0]) => {
    const values: Record<string, string> = {};
    await saveXaiCredential(credential, {
      attemptCredentials: {
        async get(key: string) {
          return values[key] ?? null;
        },
        async set(key: string, value: string) {
          values[key] = value;
        },
        async delete(key: string) {
          delete values[key];
        },
      },
    } as unknown as Parameters<typeof saveXaiCredential>[1]);
    return values;
  };
  const devinSession = (name: string) => ({
    sessionToken: `devin-session-token$${fake(name)}`,
    credentialMode: 'session',
    apiServerUrl: 'https://server.codeium.com',
    nativeGeneration: 'devin-credentials-toml-v1',
    nativeMetadata: JSON.stringify({
      devin_webapp_host: 'app.devin.ai',
      devin_api_url: 'https://api.devin.ai',
    }),
  });
  const oauthPair = (name: string) => ({
    accessToken: fake(`${name}-access`),
    refreshToken: fake(`${name}-refresh`),
    expiresAtMs: future,
  });
  return {
    'happier.agent.claude/claude-subscription': {
      'setup-token': { setupToken: fake('claude-setup') },
      oauth: { ...oauthPair('claude'), scopes: '["user:inference"]' },
      'native-import': {
        ...oauthPair('claude-native'),
        scopes: '["user:inference"]',
      },
    },
    'happier.agent.claude/anthropic': {
      'api-key': { token: fake('anthropic') },
    },
    'happier.agent.codex/openai-codex': Object.fromEntries(
      ['oauth', 'device', 'native-import'].map((mode) => [
        mode,
        {
          accessToken: jwt(`codex-access-${mode}`),
          refreshToken: fake(`codex-refresh-${mode}`),
          idToken: jwt(`codex-id-${mode}`),
          expiresAtMs: future,
          providerAccountId: 'account-1',
        },
      ]),
    ),
    'happier.agent.kimi/kimi-code': {
      device: {
        ...oauthPair('kimi'),
        credentialKind: 'oauth',
        apiBase: 'https://api.kimi.com/coding/v1',
      },
      'api-key': {
        accessToken: fake('kimi-key'),
        credentialKind: 'token',
        apiBase: 'https://api.kimi.com/coding/v1',
      },
      'native-import': {
        ...oauthPair('kimi-native'),
        credentialKind: 'oauth',
        apiBase: 'https://api.kimi.com/coding/v1',
      },
    },
    'happier.agent.gemini/gemini-account': {
      'api-key': { apiKey: fake('gemini-key') },
      'service-account': await geminiServiceAccount(),
    },
    'happier.agent.cursor/cursor-account': {
      subscription: { ...oauthPair('cursor'), credentialKind: 'oauth' },
      'api-key': { apiKey: fake('cursor-key') },
      'native-import': {
        ...oauthPair('cursor-native'),
        credentialKind: 'oauth',
      },
    },
    'happier.voice.openai/openai': { 'api-key': { token: fake('openai') } },
    'happier.review.coderabbit/coderabbit-account': {
      'native-login': await codeRabbitLogin(),
    },
    'happier.agent.grok/xai': {
      device: await xai({
        mode: 'subscription',
        accessToken: fake('xai-access'),
        refreshToken: fake('xai-refresh'),
        expiresAtMs: Date.UTC(2100, 0, 1),
      }),
      'api-key': await xai({ mode: 'api-key', accessToken: fake('xai-key') }),
      'native-import': await xai({
        mode: 'subscription',
        accessToken: fake('xai-native'),
        expiresAtMs: Date.UTC(2100, 0, 1),
      }),
    },
    'happier.agent.devin/devin-account': {
      'browser-session': devinSession('devin-session'),
      'enterprise-seat': {
        seatToken: fake('devin-seat'),
        credentialMode: 'enterprise',
        apiServerUrl: 'https://server.enterprise.windsurf.com',
        nativeGeneration: 'devin-credentials-toml-v1',
        nativeMetadata: '{}',
      },
      'native-import': devinSession('devin-native'),
    },
    'happier.agent.muse/muse-account': {
      device: {
        accessToken: fake('muse-access'),
        apiKey: fake('muse-key'),
        credentialMode: 'native',
        nativeMechanism: '"oauth"',
        expiresAtMs: future,
        nativeApiBaseUrl: 'https://api.meta.ai/v1',
        nativeObtainedVia: 'device',
      },
      'api-key': { apiKey: fake('muse-manual'), credentialMode: 'manual' },
      'native-import': {
        accessToken: fake('muse-native'),
        apiKey: fake('muse-native-key'),
        credentialMode: 'native',
        nativeMechanism: '"oauth"',
        expiresAtMs: future,
        nativeApiBaseUrl: 'https://api.meta.ai/v1',
        nativeObtainedVia: 'login',
      },
    },
    'happier.agent.antigravity/antigravity-account': Object.fromEntries(
      ['oauth-personal', 'native-import'].map((mode) => [
        mode,
        {
          ...oauthPair(`antigravity-${mode}`),
          scopes: '[]',
          projectId: 'project',
        },
      ]),
    ),
    'happier.scm.forge.github/github-account': Object.fromEntries(
      [
        'copilot-device',
        'copilot-token',
        'fine-grained-pat',
        'native-import',
      ].map((mode) => [
        mode,
        {
          token: `github_pat_${fake(`github-${mode}`)}`,
          credentialKind: 'token',
        },
      ]),
    ),
  };
}

/**
 * A delivered file whose secret is a field inside it: the field printed on its own is masked too,
 * not only the whole file.
 */
const INNER_SECRETS: Readonly<Record<string, string>> = {
  'happier.agent.gemini/gemini-account/service-account': `-----BEGIN PRIVATE KEY-----\n${fake('gemini-private-key')}\n-----END PRIVATE KEY-----\n`,
  'happier.review.coderabbit/coderabbit-account/native-login': fake('coderabbit'),
};

/** Every destination a bundled Agent requests from these services; one key or file per request. */
const ENVIRONMENT_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_CODEX_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'HAPPIER_CONNECTED_OPENAI_API_KEY',
  'KIMI_API_KEY',
  'HAPPIER_KIMI_ACCESS_TOKEN',
  'HAPPIER_CONNECTED_KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'XAI_API_KEY',
  'XAI_OAUTH_TOKEN',
  'HAPPIER_CONNECTED_XAI_API_KEY',
  'DEVIN_API_KEY',
  'WINDSURF_API_KEY',
  'MUSE_CODE_CREDENTIAL',
  'META_API_KEY',
  'GOOGLE_ANTIGRAVITY_CREDENTIAL',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
];
const FILE_IDS = [
  '.credentials.json',
  'auth.json',
  'config.toml',
  'google-service-account.json',
  '.coderabbit/auth.json',
  'devin/credentials.toml',
  'muse/auth.json',
  'antigravity-acp/acp_token.json',
];

type BundledService = Readonly<{
  key: string;
  modes: readonly unknown[];
  runtime: ConnectedAccountRuntime;
}>;

/** Bundled manifests and their activated runtimes, plus the services an Agent delivers into a Session. */
async function readBundledAgentDeliveredServices(): Promise<
  Readonly<{
    services: readonly BundledService[];
    delivered: ReadonlySet<string>;
  }>
> {
  const services: BundledService[] = [];
  const delivered = new Set<string>();
  // Manifests load concurrently; each one only adds to the two collections.
  await Promise.all(readdirSync(PLUGINS_ROOT).map(async (dir) => {
    const packageJson = join(PLUGINS_ROOT, dir, 'package.json');
    if (
      !existsSync(packageJson) ||
      !existsSync(join(PLUGINS_ROOT, dir, 'src', 'manifest.ts'))
    )
      return;
    const packageManifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name: string; exports?: Record<string, unknown> };
    // Only a package that publishes its manifest entry contributes bundled declarations here.
    if (!packageManifest.exports || !Object.hasOwn(packageManifest.exports, './manifest')) return;
    const name = packageManifest.name;
    const loaded = (await import(`${name}/manifest`)) as Record<
      string,
      unknown
    >;
    const manifest = loaded.PLUGIN_MANIFEST as
      | {
          id: string;
          contributes?: {
            connectedAccountDescriptors?: readonly {
              id: string;
              authentication: { modes: readonly { id: string }[] };
            }[];
            agents?: readonly {
              connectedAccounts?: readonly {
                service: string | { pluginId: string; localId: string };
                materializationKinds?: readonly string[];
              }[];
            }[];
          };
        }
      | undefined;
    if (!manifest?.contributes) return;
    for (const agent of manifest.contributes.agents ?? [])
      for (const use of agent.connectedAccounts ?? []) {
        if (
          !use.materializationKinds?.some(
            (kind) => kind === 'environment' || kind === 'files',
          )
        )
          continue;
        delivered.add(
          typeof use.service === 'string'
            ? `${manifest.id}/${use.service}`
            : `${use.service.pluginId}/${use.service.localId}`,
        );
      }
    const descriptors = manifest.contributes.connectedAccountDescriptors ?? [];
    if (!descriptors.length) return;
    // Activation is the host's registration path; this records only Connected Account runtimes.
    const runtimes: Record<string, ConnectedAccountRuntime> = {};
    const registry = (family: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) =>
            property === 'register'
              ? (id: string, runtime: ConnectedAccountRuntime) => {
                  if (family === 'connectedAccounts') runtimes[id] = runtime;
                }
              : () => undefined,
        },
      );
    const activate = (loaded.activate ??
      Object.values(loaded).find(
        (value): value is { activate: unknown } =>
          Boolean(value) &&
          typeof value === 'object' &&
          typeof (value as { activate?: unknown }).activate === 'function',
      )?.activate) as ((api: unknown) => unknown) | undefined;
    if (activate)
      await activate(
        new Proxy(
          {},
          { get: (_target, property) => registry(String(property)) },
        ),
      );
    for (const descriptor of descriptors) {
      const runtime = runtimes[descriptor.id];
      if (runtime)
        services.push({
          key: `${manifest.id}/${descriptor.id}`,
          modes: descriptor.authentication.modes,
          runtime,
        });
    }
  }));
  return { services, delivered };
}

/**
 * Everything a runtime writes into a Session's env and home for one stored credential, and the
 * secret values it names for the host to register beside the collector's (as the host's receipt does).
 */
async function readDelivered(
  runtime: ConnectedAccountRuntime,
  modeId: string,
  values: StoredShape,
): Promise<Readonly<{ output: string; secretValues: readonly string[] }>> {
  const credentials = {
    async get(key: string) {
      return values[key] ?? null;
    },
    async set() {},
    async delete() {},
  };
  const http = {
    async request() {
      return {
        status: 200,
        headers: {},
        finalUrl: 'https://provider.example.test',
        body: new TextEncoder().encode('{"data":[]}'),
      };
    },
  };
  const context = {
    signal: new AbortController().signal,
    credentials,
    services: { http },
    invokedAtMs: Date.now(),
    account: { accountId: 'account-1' },
    configuration: { target: { modeId }, values: {} },
  } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
  const outputs: string[] = [];
  const secretValues: string[] = [];
  // A destination this mode does not serve refuses; refusal delivers nothing.
  for (const key of ENVIRONMENT_KEYS) {
    try {
      const result = await runtime.materialize(
        { kind: 'environment', keys: [key] },
        context,
        {},
      );
      if (result.kind === 'environment')
        outputs.push(...Object.values(result.env));
      secretValues.push(...(result.secretValues ?? []));
    } catch {
      /* not a destination of this mode */
    }
  }
  for (const fileId of FILE_IDS) {
    try {
      const result = await runtime.materialize(
        { kind: 'files', fileIds: [fileId] },
        context,
        {},
      );
      if (result.kind === 'files')
        outputs.push(
          ...Object.values(result.files).map((bytes) =>
            new TextDecoder().decode(bytes),
          ),
        );
      secretValues.push(...(result.secretValues ?? []));
    } catch {
      /* not a destination of this mode */
    }
  }
  return { output: outputs.join('\n'), secretValues };
}

describe('bundled Connected Account transcript secret coverage', () => {
  it('registers every secret each Agent-delivered account writes into a Session, for every mode', async () => {
    const shapes = await storedShapes();
    const { services, delivered } = await readBundledAgentDeliveredServices();
    const rows: string[] = [];
    const leaks: string[] = [];
    for (const service of services) {
      if (!delivered.has(service.key)) continue;
      for (const declared of service.modes) {
        const mode =
          PluginConnectedAccountAuthenticationModeV2Schema.parse(declared);
        const row = `${service.key}/${mode.id}`;
        rows.push(row);
        const values = shapes[service.key]?.[mode.id];
        if (!values) {
          leaks.push(`${row}: no stored shape`);
          continue;
        }
        const { output, secretValues } = await readDelivered(service.runtime, mode.id, values);
        if (!output.includes('fake-secret-')) {
          leaks.push(`${row}: delivers no credential`);
          continue;
        }
        let transcript = output;
        const secrets = [...createConnectedAccountCredentialRedaction({
          mode,
          credential: { v: 1, values },
          configuration: {},
        }).readSecretValues(), ...secretValues];
        for (const secret of [...secrets].sort(
          (left, right) => right.length - left.length,
        ))
          transcript = transcript.split(secret).join('[redacted]');
        const leaked = [
          ...new Set(transcript.match(/fake-secret-[a-z0-9-]+/g) ?? []),
        ];
        if (leaked.length > 0) leaks.push(`${row}: leaks ${leaked.join(', ')}`);
        const inner = INNER_SECRETS[row];
        if (inner) {
          let printed = inner;
          for (const secret of [...secrets].sort((left, right) => right.length - left.length)) printed = printed.split(secret).join('[redacted]');
          if (printed.includes('fake-secret-')) leaks.push(`${row}: its inner secret printed alone is not masked`);
        }
      }
    }
    expect(
      [...delivered].filter(
        (key) => !services.some((service) => service.key === key),
      ),
    ).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
    expect(leaks).toEqual([]);
  }, 60_000);
});
