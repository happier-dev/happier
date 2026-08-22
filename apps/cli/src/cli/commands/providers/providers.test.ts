import { describe, expect, it, vi } from 'vitest';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  SavedSecretSchema,
  createProviderErrorV1,
  readOwnRecordValue,
  readProviderSettingsFromAccountSettingsV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import { DaemonProviderConnectionViewV1Schema } from '@happier-dev/protocol/rpc';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createProviderConnectionService } from '@/providers/connections/service';
import type { ProviderModelLoadResult } from '@/providers/modelManagement/load';
import { executeProvidersCommand, ProviderCliError, type ProviderCliDependencies } from './index';

const contributionKey = 'acme.gateway/gateway';
const existingSavedSecret = SavedSecretSchema.parse({
  id: 'secret-existing',
  name: 'Existing',
  kind: 'apiKey',
  encryptedValue: {
    _isSecretValue: true,
    encryptedValue: { t: 'enc-v1', c: 'sealed-existing' },
  },
  createdAt: 50,
  updatedAt: 50,
});

function contribution(
  name = 'Gateway',
  options: Readonly<{ credentialRequired?: boolean; baseUrl?: string }> = {},
): ResolvedProviderContribution {
  return {
    provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.gateway',
    identity: { pluginId: 'acme.gateway', localId: 'gateway' },
    definition: ProviderContributionV1Schema.parse({
      v: 1, id: 'gateway', name, kind: 'cloud',
      endpointTemplates: [{
        id: 'responses', protocol: 'openai-responses', baseUrl: options.baseUrl ?? 'https://gateway.example/v1',
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      ...(options.credentialRequired ? {
        credential: {
          kind: 'apiKey', slotId: 'apiKey', required: true,
          transports: [{
            id: 'gateway-bearer', protocols: ['openai-responses'], uses: ['probe', 'runtime'],
            destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
          }],
        },
      } : {}),
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    }),
  };
}

function localContribution(
  localUrlCandidates: readonly string[] = [
    'http://127.0.0.1:11434/v1',
    'http://127.0.0.1:1234/v1',
  ],
  options: Readonly<{ credentialRequired?: boolean }> = {},
): ResolvedProviderContribution {
  const value = contribution('Local Gateway', { credentialRequired: options.credentialRequired });
  return {
    ...value,
    definition: ProviderContributionV1Schema.parse({
      ...value.definition,
      kind: 'local',
      endpointTemplates: [{
        id: 'responses', protocol: 'openai-responses', localUrlCandidates,
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      catalog: {
        source: 'probe', manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
      },
      discovery: {
        v: 1,
        listener: { executableBasenames: ['local-gateway'], defaultPorts: [11434, 1234] },
        availabilityProbe: { endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' },
      },
    }),
  };
}

function harness(overrides: Partial<ProviderCliDependencies> = {}, initialSecrets: readonly unknown[] = []) {
  let raw: Record<string, unknown> = { providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1, secrets: [...initialSecrets] };
  const providersByContributionKey = new Map([[contributionKey, contribution()]]);
  const registry: ProviderContributionRegistryView = {
    providersByContributionKey,
  };
  let nextId = 1;
  const connectionService = createProviderConnectionService({
    machineId: 'machine-a',
    featureGate: { isEnabled: () => true },
    loadSnapshot: async () => ({
      accountSettings: AccountSettingsSchema.parse(raw),
      rawAccountSettings: raw,
      registry,
    }),
    updateAccountSettings: async (mutate) => { raw = mutate(raw); return raw; },
    collectDnsEvidence: async () => new Map([
      ['https://gateway.example/v1', ['1.1.1.1']],
      ['https://changed.example/v1', ['1.1.1.2']],
      ['http://127.0.0.1:11434/v1', ['127.0.0.1']],
      ['http://127.0.0.1:1234/v1', ['127.0.0.1']],
      ['http://127.0.0.1:8080/v1', ['127.0.0.1']],
    ]),
    resolveConnection: ({ accountSettings, connectionId, machineId, registry: inputRegistry, dnsEvidence }) =>
      resolveProviderConnectionForMachine({
        accountSettings, connectionId, machineId, registry: inputRegistry,
        dnsEvidenceByEndpointUrl: dnsEvidence,
      }),
    runtimeSummary: async () => ({
      summary: { health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [] },
      probeObservationIdentity: null,
    }),
    now: () => 100,
  });
  const deps: ProviderCliDependencies = {
    assertProvidersFeatureEnabled: () => {},
    connections: connectionService,
    loadSnapshot: async () => ({ accountSettings: raw, machineId: 'machine-a', registry }),
    allocateConnectionId: () => `pc_${nextId++}`,
    probe: vi.fn(async () => ({ status: 'success' as const, models: [], requestFingerprint: 'probe-request:v1:test' as never })),
    models: vi.fn(async () => [{ id: 'model-a', source: 'manual' as const, stale: false, loadState: 'unknown' as const }]),
    loadModel: vi.fn(async () => ({ status: 'loaded' as const, source: 'requested' as const })),
    mutateModelSettings: vi.fn(async (input) => ({ status: 'success' as const, action: input.action })),
    readJsonFile: vi.fn(async () => { throw new Error('not configured'); }),
    prompt: vi.fn(async () => ''),
    promptSecret: vi.fn(async () => ''),
    createSavedSecret: vi.fn(async () => { throw new Error('not configured'); }),
    ...overrides,
  };
  return { deps, getRaw: () => raw, registry, providersByContributionKey };
}

function settings(raw: Record<string, unknown>): ProviderSettingsV1 {
  return readProviderSettingsFromAccountSettingsV1(raw).settings;
}

describe('happier providers command domain', () => {
  it('accepts and persists the exact canonical Provider contribution key', async () => {
    const h = harness();
    await expect(executeProvidersCommand(['add', contributionKey], h.deps)).resolves.toMatchObject({
      ok: true,
      data: { contributionKey },
    });
    expect(settings(h.getRaw()).connections[0]?.source).toEqual({
      kind: 'contribution',
      contributionKey,
    });
  });

  it('keeps friendly Provider contribution lookup ambiguous after key normalization', async () => {
    const h = harness();
    h.providersByContributionKey.set('acme.second/gateway', contribution());

    await expect(executeProvidersCommand(['add', 'gateway'], h.deps)).rejects.toMatchObject({
      code: 'provider_contribution_ambiguous',
      details: {
        candidates: [
          { contributionKey: 'acme.gateway/gateway' },
          { contributionKey: 'acme.second/gateway' },
        ],
      },
    });
  });

  it('fails every provider command closed at the root feature gate before settings, secrets, or services', async () => {
    const h = harness();
    const assertProvidersFeatureEnabled = vi.fn(() => {
      throw new ProviderCliError('provider_feature_disabled', 'Providers are disabled by server policy');
    });
    const loadSnapshot = vi.fn(h.deps.loadSnapshot);
    const deps = { ...h.deps, assertProvidersFeatureEnabled, loadSnapshot } as ProviderCliDependencies;
    const commands = [
      ['list'],
      ['show', 'pc_1'],
      ['add', contributionKey],
      ['add', '--custom'],
      ['edit', 'pc_1', '--name', 'Work'],
      ['enable', 'pc_1'],
      ['disable', 'pc_1'],
      ['bind-secret', 'pc_1', '--scope', 'account', '--saved-secret-id', 'secret-a'],
      ['unbind-secret', 'pc_1', '--scope', 'account'],
      ['replace-secret', 'pc_1', '--scope', 'account'],
      ['add-model', 'pc_1', '--models', 'model-a'],
      ['remove-model', 'pc_1', '--model', 'model-a'],
      ['probe', 'pc_1'],
      ['test', 'pc_1'],
      ['models', 'pc_1'],
      ['load-model', 'pc_1', '--model', 'm'],
      ['remove', 'pc_1'],
    ] as const;
    for (const args of commands) {
      await expect(executeProvidersCommand(args, deps)).rejects.toMatchObject({ code: 'provider_feature_disabled' });
    }
    expect(assertProvidersFeatureEnabled).toHaveBeenCalledTimes(commands.length);
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(h.deps.probe).not.toHaveBeenCalled();
    expect(h.deps.models).not.toHaveBeenCalled();
    expect(h.deps.loadModel).not.toHaveBeenCalled();
    expect(h.deps.prompt).not.toHaveBeenCalled();
    expect(h.deps.promptSecret).not.toHaveBeenCalled();
    expect(h.deps.createSavedSecret).not.toHaveBeenCalled();
    expect(h.getRaw()).toEqual({ providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1, secrets: [] });
  });

  it('lists configured connections separately from available contributions and never emits secrets', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    const result = await executeProvidersCommand(['list', '--available', '--json'], h.deps);
    expect(result).toMatchObject({ ok: true, kind: 'providers_list', data: {
      connections: [{ connectionId: 'pc_1', contributionKey }],
      available: [],
    } });
    expect(JSON.stringify(result)).not.toContain('secretBindingsByConnectionId');
    expect(JSON.stringify(result)).not.toContain('encryptedValue');
  });

  it('reuses a contribution default unless --name explicitly requests another connection', async () => {
    const h = harness();
    expect(await executeProvidersCommand(['add', contributionKey], h.deps)).toMatchObject({
      ok: true, data: { connectionId: 'pc_1', created: true },
    });
    expect(await executeProvidersCommand(['add', contributionKey], h.deps)).toMatchObject({
      ok: true, data: { connectionId: 'pc_1', created: false },
    });
    expect(await executeProvidersCommand(['add', contributionKey, '--name', 'Work'], h.deps)).toMatchObject({
      ok: true, data: { connectionId: 'pc_3', created: true },
    });
    expect(settings(h.getRaw()).connections.map((entry) => entry.displayName)).toEqual(['Gateway', 'Work']);
  });

  it('rejects add when the reviewed contribution destination changes before create', async () => {
    const h = harness();
    const previewCreateContribution = vi.fn(async (
      input: Parameters<typeof h.deps.connections.previewCreateContribution>[0],
    ) => {
      const preview = await h.deps.connections.previewCreateContribution(input);
      h.providersByContributionKey.set(contributionKey, contribution('Gateway', {
        baseUrl: 'https://changed.example/v1',
      }));
      return preview;
    });
    const deps: ProviderCliDependencies = {
      ...h.deps,
      connections: { ...h.deps.connections, previewCreateContribution },
    };

    await expect(executeProvidersCommand(['add', contributionKey], deps)).rejects.toMatchObject({
      code: 'provider_authorization_changed',
    });
    expect(settings(h.getRaw()).connections).toEqual([]);
  });

  it('returns exact local choices before secret entry and creates only the explicitly reviewed candidate', async () => {
    const preparedSavedSecret = {
      id: 'secret-local',
      record: {
        id: 'secret-local', name: 'Local Gateway API key', kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: 'sealed-local' } },
        createdAt: 100, updatedAt: 100,
      },
    };
    const promptSecret = vi.fn(async () => 'sk-local');
    const createSavedSecret = vi.fn(async () => preparedSavedSecret);
    const h = harness({ promptSecret, createSavedSecret });
    h.providersByContributionKey.set(contributionKey, localContribution(undefined, { credentialRequired: true }));

    let selectionError: ProviderCliError | null = null;
    try {
      await executeProvidersCommand(['add', contributionKey], h.deps);
    } catch (error) {
      if (!(error instanceof ProviderCliError)) throw error;
      selectionError = error;
    }
    expect(selectionError).toMatchObject({
      code: 'provider_authorization_changed',
      details: {
        candidates: expect.arrayContaining([
          expect.objectContaining({
            candidateId: expect.stringMatching(/^discovery-candidate:v1:/u),
            endpoints: [expect.objectContaining({ normalizedUrl: 'http://127.0.0.1:1234/v1' })],
          }),
        ]),
      },
    });
    expect(selectionError?.message).toContain('--candidate-id');
    expect(selectionError?.message).toContain('http://127.0.0.1:1234/v1');
    expect(promptSecret).not.toHaveBeenCalled();
    expect(createSavedSecret).not.toHaveBeenCalled();
    expect(settings(h.getRaw()).connections).toEqual([]);
    expect(h.getRaw().secrets).toEqual([]);

    const candidates = (selectionError?.details as Readonly<{
      candidates?: readonly Readonly<{
        candidateId: string;
        endpoints: readonly Readonly<{ normalizedUrl: string }>[];
      }>[];
    }> | undefined)?.candidates ?? [];
    const selected = candidates.find((candidate) =>
      candidate.endpoints.some((endpoint) => endpoint.normalizedUrl === 'http://127.0.0.1:1234/v1'));
    if (!selected) throw new TypeError('Expected the selected local Provider candidate');

    await expect(executeProvidersCommand([
      'add', contributionKey, '--candidate-id', selected.candidateId,
    ], h.deps)).resolves.toMatchObject({ ok: true, kind: 'providers_add', data: { created: true } });
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(createSavedSecret).toHaveBeenCalledTimes(1);
    const created = settings(h.getRaw()).connections[0];
    expect(readOwnRecordValue(created?.endpointOverridesByMachineId, 'machine-a')).toEqual([
      { endpointTemplateId: 'responses', baseUrl: 'http://127.0.0.1:1234/v1' },
    ]);
    expect((h.getRaw().secrets as readonly unknown[])).toHaveLength(1);
  });

  it('rejects an expired terminal candidate before prompting for or persisting a secret', async () => {
    const promptSecret = vi.fn(async () => 'sk-must-not-be-read');
    const createSavedSecret = vi.fn(async () => { throw new Error('must not persist'); });
    const h = harness({ promptSecret, createSavedSecret });
    h.providersByContributionKey.set(contributionKey, localContribution(undefined, { credentialRequired: true }));

    let candidates: readonly Readonly<{ candidateId: string }>[] = [];
    try {
      await executeProvidersCommand(['add', contributionKey], h.deps);
    } catch (error) {
      if (!(error instanceof ProviderCliError)) throw error;
      candidates = (error.details as Readonly<{
        candidates?: readonly Readonly<{ candidateId: string }>[];
      }> | undefined)?.candidates ?? [];
    }
    const expiredCandidateId = candidates[0]?.candidateId;
    if (!expiredCandidateId) throw new TypeError('Expected an expiring local Provider candidate');
    h.providersByContributionKey.set(contributionKey, localContribution([
      'http://127.0.0.1:11435/v1',
      'http://127.0.0.1:1235/v1',
    ], { credentialRequired: true }));

    await expect(executeProvidersCommand([
      'add', contributionKey, '--candidate-id', expiredCandidateId,
    ], h.deps)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
    expect(promptSecret).not.toHaveBeenCalled();
    expect(createSavedSecret).not.toHaveBeenCalled();
    expect(settings(h.getRaw()).connections).toEqual([]);
    expect(h.getRaw().secrets).toEqual([]);
  });

  it('atomically binds a hidden SavedSecret while adding a required-key contribution', async () => {
    const preparedSavedSecret = {
      id: 'secret-new',
      record: {
        id: 'secret-new', name: 'Gateway API key', kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: 'sealed' } },
        createdAt: 100, updatedAt: 100,
      },
    };
    const h = harness({
      promptSecret: vi.fn(async () => 'sk-private'),
      createSavedSecret: vi.fn(async () => preparedSavedSecret),
    });
    h.providersByContributionKey.set(contributionKey, contribution('Gateway', { credentialRequired: true }));

    await expect(executeProvidersCommand(['add', contributionKey], h.deps)).resolves.toMatchObject({
      ok: true,
      data: { connectionId: 'pc_1', contributionKey, created: true },
    });

    expect(h.deps.promptSecret).toHaveBeenCalledTimes(1);
    expect(h.deps.createSavedSecret).toHaveBeenCalledWith({ name: 'Gateway API key', value: 'sk-private' });
    expect((h.getRaw().secrets as unknown[])).toHaveLength(1);
    expect(readOwnRecordValue(settings(h.getRaw()).secretBindingsByConnectionId, 'pc_1')?.account)
      .toEqual({ apiKey: 'secret-new' });
    expect(JSON.stringify(h.getRaw())).not.toContain('sk-private');
  });

  it('does not prompt, create an orphan secret, or rebind when a required-key default already exists', async () => {
    let nextSecret = 1;
    const h = harness({
      promptSecret: vi.fn(async () => `sk-private-${nextSecret}`),
      createSavedSecret: vi.fn(async () => {
        const id = `secret-${nextSecret++}`;
        return {
          id,
          record: {
            id, name: 'Gateway API key', kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: `sealed-${id}` } },
            createdAt: 100, updatedAt: 100,
          },
        };
      }),
    });
    h.providersByContributionKey.set(contributionKey, contribution('Gateway', { credentialRequired: true }));

    await expect(executeProvidersCommand(['add', contributionKey], h.deps)).resolves.toMatchObject({
      ok: true,
      data: { connectionId: 'pc_1', contributionKey, created: true },
    });
    const beforeDuplicate = structuredClone(h.getRaw());
    await expect(executeProvidersCommand(['add', contributionKey], h.deps)).resolves.toMatchObject({
      ok: true,
      data: { connectionId: 'pc_1', contributionKey, created: false },
    });
    await expect(executeProvidersCommand([
      'add', contributionKey, '--saved-secret-id', 'secret-1',
    ], h.deps)).resolves.toMatchObject({
      ok: true,
      data: { connectionId: 'pc_1', contributionKey, created: false },
    });

    expect(h.deps.promptSecret).toHaveBeenCalledTimes(1);
    expect(h.deps.createSavedSecret).toHaveBeenCalledTimes(1);
    expect(h.getRaw()).toEqual(beforeDuplicate);
    expect(h.getRaw().secrets).toHaveLength(1);
    expect(readOwnRecordValue(settings(h.getRaw()).secretBindingsByConnectionId, 'pc_1')?.account)
      .toEqual({ apiKey: 'secret-1' });
  });

  it('does not create a required-key contribution when hidden secret entry is cancelled', async () => {
    const h = harness({ promptSecret: vi.fn(async () => '') });
    h.providersByContributionKey.set(contributionKey, contribution('Gateway', { credentialRequired: true }));

    await expect(executeProvidersCommand(['add', contributionKey], h.deps)).rejects.toMatchObject({
      code: 'provider_secret_missing',
    });

    expect(settings(h.getRaw()).connections).toEqual([]);
    expect(h.getRaw().secrets).toEqual([]);
  });

  it('reports credential transport, not contribution availability, when binding a no-auth contribution', async () => {
    const h = harness({}, [existingSavedSecret]);
    await executeProvidersCommand(['add', contributionKey], h.deps);
    const before = structuredClone(h.getRaw());

    await expect(executeProvidersCommand([
      'bind-secret', 'pc_1', '--scope', 'account', '--saved-secret-id', 'secret-existing',
    ], h.deps)).rejects.toMatchObject({
      code: 'provider_credential_transport_unavailable',
      details: {
        code: 'provider_credential_transport_unavailable',
        action: 'review_credential_transport',
      },
    });

    expect(h.getRaw()).toEqual(before);
  });

  it('keeps unbind cleanup available when a contribution becomes no-auth or unavailable', async () => {
    for (const sourceState of ['no-auth', 'unavailable'] as const) {
      const h = harness({}, [existingSavedSecret]);
      h.providersByContributionKey.set(contributionKey, contribution('Gateway', { credentialRequired: true }));
      await executeProvidersCommand([
        'add', contributionKey, '--saved-secret-id', 'secret-existing',
      ], h.deps);
      expect(readOwnRecordValue(settings(h.getRaw()).secretBindingsByConnectionId, 'pc_1')?.account)
        .toEqual({ apiKey: 'secret-existing' });

      if (sourceState === 'no-auth') h.providersByContributionKey.set(contributionKey, contribution());
      else h.providersByContributionKey.delete(contributionKey);

      await expect(executeProvidersCommand([
        'unbind-secret', 'pc_1', '--scope', 'account',
      ], h.deps)).resolves.toMatchObject({
        ok: true, kind: 'providers_unbind_secret', data: { connectionId: 'pc_1' },
      });
      expect(readOwnRecordValue(settings(h.getRaw()).secretBindingsByConnectionId, 'pc_1'))
        .toBeUndefined();
    }
  });

  it('requires unique friendly connection names and returns ambiguity candidates', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey, '--name', 'Shared'], h.deps);
    await executeProvidersCommand(['add', contributionKey, '--name', 'Shared'], h.deps);
    await expect(executeProvidersCommand(['remove', 'Shared'], h.deps)).rejects.toMatchObject({
      code: 'provider_connection_ambiguous',
      details: { candidates: [{ connectionId: 'pc_1' }, { connectionId: 'pc_2' }] },
    });
  });

  it('rejects raw secret argv and validates the one shared custom template form', async () => {
    const h = harness();
    await expect(executeProvidersCommand([
      'add', '--custom', '--name', 'Unsafe', '--protocol', 'openai-chat',
      '--base-url', 'https://gateway.example/v1', '--api-key', 'sk-leaked', '--catalog', 'manual',
    ], h.deps)).rejects.toMatchObject({ code: 'raw_secret_argv_forbidden' });
    expect(h.getRaw()).toEqual({ providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1, secrets: [] });

    await expect(executeProvidersCommand([
      'add', '--custom', '--name', 'Invalid', '--protocol', 'anthropic',
      '--base-url', 'https://gateway.example/v1', '--catalog', 'probe',
    ], h.deps)).rejects.toBeInstanceOf(ProviderCliError);
  });

  it('rejects unknown custom flags and mixing the advanced JSON form with the simple DSL', async () => {
    const h = harness({ readJsonFile: vi.fn(async () => ({
      v: 1,
      name: 'Advanced',
      kind: 'custom',
      endpointTemplates: [{
        id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    })) });
    await expect(executeProvidersCommand([
      'add', '--custom', '--name', 'Unsafe', '--protocol', 'openai-chat',
      '--base-url', 'https://gateway.example/v1', '--catalog', 'manual', '--unsupported', 'value',
    ], h.deps)).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(executeProvidersCommand([
      'add', '--custom', '--advanced-json', '/tmp/provider.json', '--protocol', 'openai-chat',
    ], h.deps)).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(h.deps.readJsonFile).not.toHaveBeenCalled();
  });

  it('rejects duplicate flags across equals and separated-value syntax', async () => {
    const h = harness();
    await expect(executeProvidersCommand([
      'add', '--custom', '--name=First', '--name', 'Second', '--protocol', 'openai-chat',
      '--base-url', 'https://gateway.example/v1', '--catalog', 'manual',
    ], h.deps)).rejects.toMatchObject({ code: 'duplicate_flag' });

    h.providersByContributionKey.set(contributionKey, localContribution());
    await expect(executeProvidersCommand([
      'add', contributionKey,
      '--candidate-id=discovery-candidate:v1:first',
      '--candidate-id', 'discovery-candidate:v1:second',
    ], h.deps)).rejects.toMatchObject({ code: 'duplicate_flag' });
  });

  it('creates a custom connection, binds only a SavedSecret id, and preserves the strict template', async () => {
    const h = harness({}, [{ id: 'secret-1' }]);
    const result = await executeProvidersCommand([
      'add', '--custom', '--name', 'Company', '--protocol', 'openai-responses',
      '--base-url', 'https://gateway.example/v1', '--saved-secret-id', 'secret-1',
      '--credential-style', 'bearer', '--catalog', 'probe', '--models-path', '/models',
    ], h.deps);
    expect(result).toMatchObject({ ok: true, data: { connectionId: 'pc_1', contributionKey: null } });
    const providerSettings = settings(h.getRaw());
    expect(providerSettings.connections[0]?.source).toMatchObject({
      kind: 'custom', template: { endpointTemplates: [{ capabilities: { streaming: 'unknown' } }] },
    });
    expect(Object.values(providerSettings.secretBindingsByConnectionId)[0]?.account).toEqual({ apiKey: 'secret-1' });
    expect(JSON.stringify(providerSettings)).not.toContain('sk-');
  });

  it('rejects a SavedSecret binding that does not exist in the current CAS snapshot', async () => {
    const h = harness();
    await expect(executeProvidersCommand([
      'add', '--custom', '--name', 'Company', '--protocol', 'openai-responses',
      '--base-url', 'https://gateway.example/v1', '--saved-secret-id', 'secret-missing',
      '--credential-style', 'bearer', '--catalog', 'manual',
    ], h.deps)).rejects.toMatchObject({ code: 'provider_secret_missing' });
    expect(settings(h.getRaw()).connections).toEqual([]);
  });

  it('atomically persists interactive no-echo secret material and its connection binding', async () => {
    const promptSecret = vi.fn(async () => 'sk-plaintext');
    const createSavedSecret = vi.fn(async () => ({
      id: 'secret-new',
      record: {
        id: 'secret-new', name: 'Interactive API key', kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: 'sealed' } },
        createdAt: 100, updatedAt: 100,
      },
    }));
    const h = harness({ promptSecret, createSavedSecret });
    await executeProvidersCommand([
      'add', '--custom', '--name', 'Interactive', '--protocol', 'openai-chat',
      '--base-url', 'https://gateway.example/v1', '--credential-style', 'bearer', '--catalog', 'manual',
    ], h.deps);
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(createSavedSecret).toHaveBeenCalledWith({ name: 'Interactive API key', value: 'sk-plaintext' });
    expect((h.getRaw().secrets as unknown[])).toHaveLength(1);
    expect(Object.values(settings(h.getRaw()).secretBindingsByConnectionId)[0]?.account).toEqual({ apiKey: 'secret-new' });
    expect(JSON.stringify(h.getRaw())).not.toContain('sk-plaintext');
  });

  it('disables the whole connection atomically when account and machine grants coexist', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    expect(await executeProvidersCommand(['enable', 'pc_1', '--machine', 'machine-a'], h.deps)).toMatchObject({
      ok: true, data: { connectionId: 'pc_1', machineId: 'machine-a', scope: 'account' },
    });
    expect(settings(h.getRaw()).accountGrants).toHaveLength(1);
    await h.deps.connections.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_1', expectedRevision: 0,
      scope: 'machine', endpointTemplateId: 'responses', baseUrl: 'http://127.0.0.1:8080/v1',
    });
    await h.deps.connections.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_1', enabled: true,
    });
    expect(settings(h.getRaw()).machineGrants).toHaveLength(1);
    expect(await executeProvidersCommand(['disable', 'pc_1', '--machine', 'machine-a'], h.deps))
      .toMatchObject({ ok: true, data: { scope: 'connection' } });
    expect(settings(h.getRaw()).accountGrants).toEqual([]);
    expect(settings(h.getRaw()).machineGrants).toEqual([]);
  });

  it('rejects misspelled command flags instead of silently targeting the current machine', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    await expect(executeProvidersCommand(['enable', 'pc_1', '--machin', 'machine-b'], h.deps))
      .rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(settings(h.getRaw()).accountGrants).toEqual([]);
    expect(settings(h.getRaw()).machineGrants).toEqual([]);
  });

  it('rejects extra positional arguments instead of silently ignoring them', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    await expect(executeProvidersCommand(['remove', 'pc_1', 'unexpected'], h.deps))
      .rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(settings(h.getRaw()).connections).toHaveLength(1);
  });

  it('can disable an unavailable contribution without resolving endpoints or secrets', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    await executeProvidersCommand(['enable', 'pc_1'], h.deps);
    h.providersByContributionKey.delete(contributionKey);
    await expect(executeProvidersCommand(['disable', 'pc_1'], h.deps)).resolves.toMatchObject({ ok: true });
    expect(settings(h.getRaw()).accountGrants).toEqual([]);
  });

  it('delegates probe/test, models, and gated load-model through canonical service ports', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    await executeProvidersCommand(['probe', 'pc_1', '--machine', 'machine-a'], h.deps);
    await executeProvidersCommand(['test', 'pc_1', '--machine', 'machine-a'], h.deps);
    await executeProvidersCommand(['models', 'pc_1', '--machine', 'machine-a'], h.deps);
    await executeProvidersCommand(['load-model', 'pc_1', '--machine', 'machine-a', '--model', 'model-a'], h.deps);
    expect(h.deps.probe).toHaveBeenCalledTimes(2);
    expect(h.deps.probe).toHaveBeenLastCalledWith({ connectionId: 'pc_1', machineId: 'machine-a' });
    expect(h.deps.models).toHaveBeenCalledWith({ connectionId: 'pc_1', machineId: 'machine-a' });
    expect(h.deps.loadModel).toHaveBeenCalledWith({ connectionId: 'pc_1', machineId: 'machine-a', modelId: 'model-a' });
  });

  it('rejects non-canonical raw model ids before load or settings mutation work', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);

    for (const subcommand of ['load-model', 'remove-model']) {
      for (const modelId of [' model-a', 'model-a ', 'invalid model', '   ', '']) {
        await expect(executeProvidersCommand([
          subcommand, 'pc_1', '--model', modelId,
        ], h.deps)).rejects.toMatchObject({ code: 'provider_model_not_found' });
      }
      await expect(executeProvidersCommand([
        subcommand, 'pc_1', '--model=',
      ], h.deps)).rejects.toMatchObject({ code: 'provider_model_not_found' });
      await expect(executeProvidersCommand([
        subcommand, 'pc_1',
      ], h.deps)).rejects.toMatchObject({ code: 'invalid_arguments' });
    }

    expect(h.deps.loadModel).not.toHaveBeenCalled();
    expect(h.deps.mutateModelSettings).not.toHaveBeenCalled();
  });

  it('cancels an in-flight direct load through the command signal and reports Provider continuation truthfully', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    const controller = new AbortController();
    const loadModel = vi.fn(async (input: Readonly<{
      connectionId: string;
      machineId: string;
      modelId: string;
      signal?: AbortSignal;
    }>) => await new Promise<ProviderModelLoadResult>((resolve) => {
      input.signal?.addEventListener('abort', () => resolve({
        status: 'cancelled',
        providerMayContinue: true,
      }), { once: true });
    }));
    const pending = executeProvidersCommand(
      ['load-model', 'pc_1', '--machine', 'machine-a', '--model', 'model-a'],
      { ...h.deps, loadModel },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(loadModel).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).resolves.toEqual({
      ok: true,
      kind: 'providers_load_model',
      data: { status: 'cancelled', providerMayContinue: true },
    });
    expect(loadModel).toHaveBeenCalledWith({
      connectionId: 'pc_1',
      machineId: 'machine-a',
      modelId: 'model-a',
      signal: controller.signal,
    });
  });

  it('surfaces probe, test, and load-model domain errors as CLI failures', async () => {
    const error = createProviderErrorV1('provider_endpoint_unreachable', {
      connectionId: 'pc_1',
      machineId: 'machine-a',
    });
    const h = harness({
      probe: vi.fn(async () => ({ status: 'error' as const, error })),
      loadModel: vi.fn(async () => ({ status: 'error' as const, error })),
    });
    await executeProvidersCommand(['add', contributionKey], h.deps);

    for (const command of [
      ['probe', 'pc_1'],
      ['test', 'pc_1'],
      ['load-model', 'pc_1', '--model', 'model-a'],
    ] as const) {
      await expect(executeProvidersCommand(command, h.deps)).rejects.toMatchObject({
        code: 'provider_endpoint_unreachable',
        details: error,
      });
    }
  });

  it('shows and edits the exact resolved connection without exposing credential identity', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    const shown = await executeProvidersCommand(['show', 'pc_1'], h.deps);
    expect(shown).toMatchObject({ ok: true, kind: 'providers_show', data: {
      connectionId: 'pc_1', contributionKey, name: 'Gateway', revision: 0,
    } });
    expect(JSON.stringify(shown)).not.toContain('secretBindingsByConnectionId');
    await expect(executeProvidersCommand(['edit', 'pc_1', '--name', 'Work gateway'], h.deps))
      .resolves.toMatchObject({ ok: true, kind: 'providers_edit', data: { name: 'Work gateway', revision: 1 } });
  });

  it('shows managed deployment effects and purpose declarations from the canonical connection view', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    const described = await h.deps.connections.describe({ machineId: 'machine-a' });
    if (described.status === 'error' || !described.connections[0]) {
      throw new TypeError('Expected the configured Provider connection');
    }
    const managedConnection = DaemonProviderConnectionViewV1Schema.parse({
      ...described.connections[0],
      provenance: 'first_party',
      credential: null,
      deployment: {
        kind: 'managedLocal',
        targetMachineId: 'machine-a',
        effects: {
          implementationIdentity: {
            pluginId: 'happier.provider.cliproxyapi',
            localId: 'cliproxyapi',
          },
          process: {
            localServiceId: 'happier-cliproxyapi-managed',
            manager: 'happier',
            lifetime: 'session',
            network: 'loopback',
            restart: 'never',
          },
          dependency: {
            kind: 'packaged-runtime-binary',
            directorySegments: ['cliproxyapi', 'unpacked'],
            executableBaseName: 'cliproxyapi',
          },
          protocols: ['anthropic', 'openai-responses'],
          connectedAccountPurposes: [{
            purpose: 'openai-upstream',
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            required: true,
            materializationKinds: ['httpHeaders'],
            target: {
              kind: 'group',
              service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
              },
              groupId: 'work',
            },
          }],
        },
      },
      managedLocalOption: {
        targetMachineId: 'machine-a',
        connectedAccountPurposes: [{
          purpose: 'openai-upstream',
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          required: true,
          materializationKinds: ['httpHeaders'],
        }],
      },
      endpoints: [],
    });
    const describe = vi.fn(async () => ({
      ...described,
      connections: [managedConnection],
    }));

    await expect(executeProvidersCommand(['show', 'pc_1'], {
      ...h.deps,
      connections: { ...h.deps.connections, describe },
    })).resolves.toMatchObject({
      ok: true,
      kind: 'providers_show',
      data: {
        deployment: {
          kind: 'managedLocal',
          effects: {
            implementationIdentity: {
              pluginId: 'happier.provider.cliproxyapi',
              localId: 'cliproxyapi',
            },
            connectedAccountPurposes: [{
              purpose: 'openai-upstream',
              target: {
                kind: 'group',
                groupId: 'work',
              },
            }],
          },
        },
        managedLocalOption: {
          connectedAccountPurposes: [{
            purpose: 'openai-upstream',
            materializationKinds: ['httpHeaders'],
          }],
        },
      },
    });
  });

  it('keeps positionals following boolean edit flags instead of consuming them as flag values', async () => {
    const automatic = harness();
    await executeProvidersCommand(['add', contributionKey], automatic.deps);
    await expect(executeProvidersCommand([
      'edit', '--automatic-name', 'pc_1',
    ], automatic.deps)).resolves.toMatchObject({
      ok: true,
      kind: 'providers_edit',
      data: { connectionId: 'pc_1' },
    });

    const clearEndpoint = harness();
    await executeProvidersCommand(['add', contributionKey], clearEndpoint.deps);
    await expect(executeProvidersCommand([
      'edit', '--clear-endpoint', 'pc_1', '--scope', 'machine', '--endpoint-template', 'responses',
    ], clearEndpoint.deps)).resolves.toMatchObject({
      ok: true,
      kind: 'providers_edit',
      data: { connectionId: 'pc_1' },
    });
  });

  it('honors the option terminator, rejects explicit boolean values, and still rejects a missing target', async () => {
    const terminated = harness();
    await expect(executeProvidersCommand([
      'add', '--', contributionKey,
    ], terminated.deps)).resolves.toMatchObject({
      ok: true,
      kind: 'providers_add',
      data: { contributionKey },
    });

    const explicitBoolean = harness();
    await expect(executeProvidersCommand([
      'list', '--available=true',
    ], explicitBoolean.deps)).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(executeProvidersCommand([
      'list', '--json=false',
    ], explicitBoolean.deps)).rejects.toMatchObject({ code: 'invalid_arguments' });

    await expect(executeProvidersCommand([
      'edit', '--automatic-name',
    ], explicitBoolean.deps)).rejects.toMatchObject({ code: 'invalid_arguments' });
  });

  it('binds, unbinds, and atomically replaces SavedSecrets without raw argv material', async () => {
    const replacement = {
      id: 'secret-new',
      record: {
        id: 'secret-new', name: 'Replacement', kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: 'sealed' } },
        createdAt: 100, updatedAt: 100,
      },
    };
    const h = harness({
      promptSecret: vi.fn(async () => 'sk-replacement'),
      createSavedSecret: vi.fn(async () => replacement),
    }, [existingSavedSecret]);
    await executeProvidersCommand([
      'add', '--custom', '--name', 'Credentialed', '--protocol', 'openai-chat',
      '--base-url', 'https://gateway.example/v1', '--credential-style', 'bearer', '--catalog', 'manual',
      '--saved-secret-id', 'secret-existing',
    ], h.deps);
    await executeProvidersCommand(['bind-secret', 'pc_1', '--saved-secret-id', 'secret-existing', '--scope', 'account'], h.deps);
    expect(readOwnRecordValue(settings(h.getRaw()).secretBindingsByConnectionId, 'pc_1')?.account).toEqual({ apiKey: 'secret-existing' });
    await executeProvidersCommand(['unbind-secret', 'pc_1', '--scope', 'account'], h.deps);
    expect(readOwnRecordValue(settings(h.getRaw()).secretBindingsByConnectionId, 'pc_1')).toBeUndefined();
    await executeProvidersCommand(['replace-secret', 'pc_1', '--scope', 'account'], h.deps);
    expect(readOwnRecordValue(settings(h.getRaw()).secretBindingsByConnectionId, 'pc_1')?.account).toEqual({ apiKey: 'secret-new' });
    expect(JSON.stringify(h.getRaw())).not.toContain('sk-replacement');
  });

  it('trims only manual entry boundaries, keeps valid model lines, and reports rejected lines', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    const result = await executeProvidersCommand([
      'add-model', 'pc_1', '--models', ' Org/Model.V2 \ninvalid model\nsecond/model\nOrg/Model.V2 ',
    ], h.deps);
    expect(h.deps.mutateModelSettings).toHaveBeenCalledWith({
      action: 'manualAdd', machineId: 'machine-a', connectionId: 'pc_1', expectedConnectionRevision: 0,
      models: [{ id: 'Org/Model.V2' }, { id: 'second/model' }],
    });
    expect(result).toMatchObject({ ok: true, kind: 'providers_add_model', data: {
      accepted: ['Org/Model.V2', 'second/model'], rejected: [{ line: 2, value: 'invalid model' }],
    } });
    await executeProvidersCommand(['remove-model', 'pc_1', '--model', 'Org/Model.V2'], h.deps);
    expect(h.deps.mutateModelSettings).toHaveBeenLastCalledWith({
      action: 'manualRemove', machineId: 'machine-a', connectionId: 'pc_1', expectedConnectionRevision: 0,
      modelId: 'Org/Model.V2',
    });
  });

  it('refuses remote machine selectors before local provider services or DNS can run', async () => {
    const h = harness();
    await executeProvidersCommand(['add', contributionKey], h.deps);
    await expect(executeProvidersCommand(['enable', 'pc_1', '--machine', 'machine-z'], h.deps))
      .rejects.toMatchObject({
        code: 'provider_not_enabled_on_machine',
        details: { requestedMachineId: 'machine-z', currentMachineId: 'machine-a' },
      });
  });

  it('keeps explicit guidance for the retired agent-setup subcommands', async () => {
    const h = harness();
    for (const subcommand of ['install', 'setup', 'status']) {
      await expect(executeProvidersCommand([subcommand, 'codex'], h.deps)).rejects.toMatchObject({
        code: 'legacy_agent_command_moved',
      });
    }
  });
});
