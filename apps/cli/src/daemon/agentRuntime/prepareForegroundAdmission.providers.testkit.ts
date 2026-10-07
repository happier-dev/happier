import fastify from 'fastify';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';

import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  FeaturesResponseSchema,
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  SavedSecretResourceMaterialsResponseV1Schema,
  buildBackendTargetKeyV2,
  encryptSecretStringV1,
  sealAccountScopedBlobCiphertext,
  sealSavedSecretResourceStoredContentV1,
  type SavedSecretCatalogMaterialStatusV1,
} from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { writeCredentialsLegacy, type Credentials } from '@/persistence';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { deriveSettingsSecretsKeyForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';

type BaseContext = Parameters<Parameters<typeof withRealForegroundAdmissionFixture>[1]>[0];
type RequestOverrides = NonNullable<Parameters<BaseContext['prepare']>[0]>;
type SettingsOptions = Readonly<{
  version: number;
  corruptProfileSecret?: boolean;
  providerSecretValue?: string;
  providerSecretUpdatedAt?: number;
  profileSecretRef?: string;
}>;
type SharedFailure = 'reference_forbidden' | 'reference_deleted' | 'reference_mode_incompatible'
  | 'reference_repair_required' | 'reference_corrupt';
type FixtureOptions = Readonly<{
  providersFeatureEnabled?: boolean;
  configFileAgent?: boolean;
  settings?: SettingsOptions;
  sharedSecretRevision?: number;
  sharedSecretFailure?: SharedFailure;
  sharedSecretHttpStatus?: number;
}>;

const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
const contributionKey = 'acme.gateway/gateway';
const sharedReference = 'happier:shared-secret:v1:resource-profile-shared';
const externalAgentPluginId = 'acme.foreground';
const externalAgentId = 'acme.foreground/fixture';

function providerPlugin(agentTargetKey: string) {
  const definition = ProviderContributionV1Schema.parse({
    v: 1, id: 'gateway', name: 'Gateway', kind: 'cloud',
    // Numeric public identity exercises the actual OS DNS adapter without an
    // external resolver or a provider network request during launch admission.
    endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://1.1.1.1/v1',
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
    catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'model-a', name: 'Model A', capabilities: { toolRoundTrips: 'supported' } }] },
    compatibilityOverrides: [{ agentTargetKey, protocol: 'openai-responses', status: 'verified', reason: 'Physical foreground fixture',
      evidence: { sourceUrls: ['https://example.test/provider'], verifiedAt: '2026-07-10', testIds: ['foreground-admission'] } }],
  });
  return { manifest: createPluginManifestV2Fixture({ id: 'acme.gateway', contributes: { providers: [definition] } }),
    files: { 'daemon.mjs': 'export function activate() {}' } };
}

function configFileAgentPlugin() {
  return {
    manifest: createPluginManifestV2Fixture({ id: externalAgentPluginId, contributes: { agents: [{
      id: 'fixture', title: 'Config-file foreground Agent', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      providerRequirements: {
        acceptsProtocols: ['openai-responses'], required: { streaming: true, toolRoundTrips: true },
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [{ protocol: 'openai-responses',
          destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] } }] },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['PROVIDER_KEY'] },
        materialization: 'configFile', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
      },
    }] } }),
    files: {
      'runtime.mjs': `export async function createRuntime() { return { sessions: { open: async () => ({
        send: async () => ({status:'admitted'}), watch: () => ({dispose(){}}), dispose(){}
      }) } }; }`,
      'daemon.mjs': `import {createRuntime} from './runtime.mjs';
        const providerBinding = {v:1, adapterVersion:1,
          prepare: () => ({v:1, materialization:'configFile', adapterBindingKey:'gateway'}),
          materialize: async ({credential,binding}) => ({v:1,kind:'configFile',
            env:[{name:'PROVIDER_KEY',value:credential.kind==='apiKey'?credential.value:null,source:'provider'}],
            files:[{relativePath:'provider.json',utf8:JSON.stringify({endpoint:binding.endpoint.normalizedUrl})}]})};
        export function activate(api) { api.agents.register('fixture',createRuntime,{providerBinding,
          sessionRunnerFactory:{module:'./runtime.mjs',export:'createRuntime',runtimeApiVersion:1}}); }`,
    },
  };
}

function sharedMaterial(options: FixtureOptions) {
  const statuses: Readonly<Record<Exclude<SharedFailure, 'reference_corrupt'>, SavedSecretCatalogMaterialStatusV1>> = {
    reference_forbidden: 'access_removed', reference_deleted: 'deleted',
    reference_mode_incompatible: 'recipient_mode_unsupported', reference_repair_required: 'update_required',
  };
  const status = options.sharedSecretFailure && options.sharedSecretFailure !== 'reference_corrupt'
    ? statuses[options.sharedSecretFailure] : 'ready';
  return SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
    resourceId: 'resource-profile-shared', encryptionMode: 'plain', recipientEnvelope: null,
    entry: { ref: sharedReference, source: 'shared_resource', relationship: 'recipient', name: 'Shared Profile secret',
      kind: 'apiKey', ownerAccountId: 'owner-account', revision: options.sharedSecretRevision ?? 4, materialStatus: status,
      capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
    storedContent: status === 'ready' ? sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource-profile-shared',
      mode: 'plain', content: { v: 1,
        name: options.sharedSecretFailure === 'reference_corrupt' ? 'Mismatched projected name' : 'Shared Profile secret',
        kind: 'apiKey', value: 'shared-profile-plaintext' },
    }) : null,
  }] });
}

type ProviderContext = BaseContext & Readonly<{
  connectionId: typeof connectionId;
  contributionKey: string;
  sharedReference: string;
  agentId: string;
  agentPluginId: string;
  agentTargetKey: string;
  scopeKey: string;
  publishSettings(options: SettingsOptions): Promise<void>;
  bootstrapFiles(): Promise<readonly string[]>;
}>;

/** Physical plugins plus actual settings/secret codecs; only Home HTTP is replaced. */
export async function withForegroundProviderFixture<T>(options: FixtureOptions, run: (context: ProviderContext) => Promise<T>): Promise<T> {
  const agentId = options.configFileAgent ? externalAgentId : 'codex';
  const agentPluginId = options.configFileAgent ? externalAgentPluginId : 'happier.agent.codex';
  const agentTargetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId });
  const plugins = [providerPlugin(agentTargetKey), ...(options.configFileAgent ? [configFileAgentPlugin()] : [])];
  return await withRealForegroundAdmissionFixture({ plugins, runtimeOptions: {
    pluginIds: options.configFileAgent ? ['acme.gateway', externalAgentPluginId] : ['acme.gateway', 'happier.agent.codex'],
  } }, async (base) => {
    const app = fastify();
    let restoreAxios: (() => void) | null = null;
    const originalFetch = globalThis.fetch;
    const accountSecret = new Uint8Array(32).fill(5);
    const credentials: Credentials = { token: 'foreground-account-token', encryption: { type: 'legacy', secret: accountSecret } };
    let settingsResponse: Readonly<{ version: number; content: Readonly<{ t: 'encrypted'; c: string }> }> | null = null;
    const features = FeaturesResponseSchema.parse({ features: {
      providers: { enabled: options.providersFeatureEnabled ?? true }, teams: { enabled: true },
    }, capabilities: {} });
    app.get('/v1/features', async () => features);
    app.get('/v1/features/authenticated', async () => features);
    app.get('/v2/account/settings', async () => settingsResponse);
    app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 0 }));
    app.get('/v1/account/saved-secrets/resources/materials', async (_request, reply) => {
      if (options.sharedSecretHttpStatus) return reply.code(options.sharedSecretHttpStatus).send({ error: 'access_removed' });
      return sharedMaterial(options);
    });
    try {
      await app.ready();
      const origin = new URL(configuration.serverUrl).origin;
      restoreAxios = installAxiosFastifyAdapter({ app, origin });
      // Real feature parsing and Saved Secret admission consume these HTTP
      // bytes through the canonical transport boundaries, never an internal stub.
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== origin) throw new Error(`Unexpected foreground Home origin: ${url.origin}`);
        const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      });
      await writeCredentialsLegacy({ token: credentials.token, secret: accountSecret });
      const initialProviderSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
        v: 1, id: connectionId, source: { kind: 'contribution', contributionKey }, role: 'default', displayName: 'Gateway',
        displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1,
      }] });
      const providersByContributionKey = base.runtime.registry.contributes.providersByContributionKey;
      if (!providersByContributionKey) throw new Error('Actual admitted Provider registry is unavailable');
      const registry = { providersByContributionKey };
      const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({ connectionId, machineId: 'machine-1',
        providerSettings: initialProviderSettings, registry,
        lifetime: createProviderOperationLifetime({ wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs }),
      });
      const resolved = resolveProviderConnectionForMachine({ connectionId, machineId: 'machine-1',
        accountSettings: { providerSettingsV1: initialProviderSettings }, registry, dnsEvidenceByEndpointUrl });
      if (resolved.status !== 'resolved') throw new Error('Physical Provider connection did not resolve');
      const providerSettings = ProviderSettingsV1Schema.parse({ ...initialProviderSettings,
        accountGrants: [{ v: 1, connectionId, connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 }],
        secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: 'provider-secret' } } },
      });
      const secretKey = deriveSettingsSecretsKeyForCredentials(credentials);
      let scopeKey = '';
      let currentVersion = options.settings?.version ?? 1;
      const publishSettings = async (params: SettingsOptions) => {
        const secret = (id: string, value: string, updatedAt = 1) => ({ id, name: id, kind: 'apiKey', createdAt: 1, updatedAt,
          encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1(value, secretKey, (length) => new Uint8Array(length).fill(3)) } });
        const settings = AccountSettingsSchema.parse({ providerSettingsV1: providerSettings,
          secrets: [secret('provider-secret', params.providerSecretValue ?? 'provider-plaintext', params.providerSecretUpdatedAt),
            params.corruptProfileSecret ? { ...secret('profile-secret', 'unused'), encryptedValue: { _isSecretValue: true, encryptedValue: 'invalid' } }
              : secret('profile-secret', 'profile-plaintext')],
          profiles: [{ id: 'profile-1', name: 'Profile', envVarRequirements: [{ name: 'PROFILE_SECRET', kind: 'secret', required: true }],
            environmentVariables: [], defaultPermissionModeByTargetKey: {}, compatibilityByTargetKey: {}, isBuiltIn: false, createdAt: 1, updatedAt: 1, version: '1.0.0' }],
          secretBindingsByProfileId: { 'profile-1': { PROFILE_SECRET: params.profileSecretRef ?? 'profile-secret' } },
        });
        settingsResponse = { version: params.version, content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
          material: { type: 'legacy', secret: accountSecret }, payload: settings, randomBytes: (length) => new Uint8Array(length).fill(9) }) } };
        const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false,
          minSettingsVersion: params.version });
        if (!snapshot.scopeKey) throw new Error('Canonical Account scope unavailable');
        scopeKey = snapshot.scopeKey;
        currentVersion = params.version;
      };
      resetInMemoryAccountSettingsContextForTests();
      await publishSettings(options.settings ?? { version: 1 });
      const request = (overrides: RequestOverrides = {}) => base.request({
        agentId, backendTarget: options.configFileAgent ? { kind: 'backend', backendId: agentId }
          : { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        profileId: 'profile-1', accountSettingsScopeKey: scopeKey, accountSettingsVersion: currentVersion,
        selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: 'model-a' } },
        ...overrides,
      });
      return await run({ ...base, connectionId, contributionKey, sharedReference, agentId, agentPluginId, agentTargetKey,
        get scopeKey() { return scopeKey; }, request, publishSettings,
        prepare: (overrides = {}, dependencies = {}) => base.prepare(request(overrides), dependencies),
        async bootstrapFiles() {
          const directory = join(base.home, 'tmp', resolveReleaseRingScopedBasename('foreground-agent-runtime-bootstraps', configuration.publicReleaseRing));
          try { return await readdir(directory); }
          catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
        },
      });
    } finally {
      restoreAxios?.();
      vi.stubGlobal('fetch', originalFetch);
      resetInMemoryAccountSettingsContextForTests();
      await app.close();
    }
  });
}
