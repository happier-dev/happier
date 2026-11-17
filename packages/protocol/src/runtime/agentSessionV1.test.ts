import { bundledUsageModelPriceCatalog } from '../usage/usageModelPriceCatalog.js';
import { describe, expect, it } from 'vitest';

import { projectMcpToolLaunchPolicyV1 } from '../mcp/servers/tools/resolveMcpToolDecisionV1.js';
import { normalizeProbedCatalogOption, ProbedCatalogOptionSchema } from '../capabilities/probedCatalogOption.js';
import { AgentConfigOptionsProbeObservationSchema, AgentModelsProbeObservationSchema, AgentProbeModelSchema } from '../capabilities/agentProbeObservation.js';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1, openSessionOwnerMetadataEnvelopeV1, parseSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1, sealSessionOwnerMetadataEnvelopeV1 } from '../sessions/metadata/sessionMetadataEnvelopesV1.js';
import {
  AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
  AgentLaunchEnvironmentV1Schema,
  AgentRuntimeJsonValueV1Schema,
  AgentSessionConfigurationSnapshotV1Schema,
  AgentSessionConfigurationUpdateV1Schema,
  AgentSessionConversationRollbackReconciliationResultV1Schema,
  AgentSessionConversationRollbackRequestV1Schema,
  AgentSessionRuntimeEventV1Schema,
  AgentSessionSendRequestV1Schema,
} from './agentSessionV1.js';

import { estimateUsageModelCost } from '../usage/usageCost.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';

it('admits typed native Connected Account identity evidence without authority or native grammar bags', () => {
  const event = { kind: 'connected-account-identity-observed', sequence: 1, sessionId: 'session', emittedAtMs: 20,
    service: { pluginId: 'plugin.acme', localId: 'subscription' }, nativeSessionId: 'native-session',
    providerOrganizationId: 'organization-2', observedAtMs: 10 };
  expect(AgentSessionRuntimeEventV1Schema.parse(event)).toEqual(event);
  expect(AgentSessionRuntimeEventV1Schema.parse({ ...event, providerOrganizationId: null }))
    .toEqual({ ...event, providerOrganizationId: null });
  for (const invalid of [{ ...event, groupId: 'host-owned' },
    { ...event, service: { ...event.service, authority: true } },
    { ...event, nativeSessionId: '' }, { ...event, observedAtMs: -1 },
    { ...event, providerOrganizationId: 42 }]) {
    expect(AgentSessionRuntimeEventV1Schema.safeParse(invalid).success).toBe(false);
  }
});

const diagnostic = {
  code: 'provider_unavailable',
  severity: 'warning',
} as const;

it('preserves complete send input beyond the former aggregate candidate ceiling', () => {
  const text = 'é'.repeat(1_250_001);
  const request = {
    inputIds: ['input-1'],
    input: { text },
    delivery: { kind: 'newTurn', turnId: 'turn-1' },
  };
  expect(AgentSessionSendRequestV1Schema.parse(request)).toEqual(request);
  const structuredRequest = { ...request, input: { text: '', structuredInput: { text } } };
  expect(AgentSessionSendRequestV1Schema.parse(structuredRequest)).toEqual(structuredRequest);
});

it('preserves native Agent model identities and presentation independently from Provider model ids', () => {
  const model = { id: ' native-model/+ = ', name: ' Native model ', extendedContextModelId: ' native-extended= ' };
  expect(AgentProbeModelSchema.parse(model)).toEqual(model);
});

it('retains a failed config refresh alongside the last observed catalog', () => {
  const snapshot = { agentId: 'native', source: 'dynamic', refreshError: true, refreshErrorMessage: ' Sign in to the native Provider.\n',
    modelConfigOptionId: 'engine-choice', configOptions: [{ id: 'engine-choice', name: 'Engine', type: 'select', currentValue: 'accepted' }] };
  expect(AgentConfigOptionsProbeObservationSchema.parse(snapshot)).toEqual(snapshot);
  const models = { agentId: snapshot.agentId, source: snapshot.source, refreshError: snapshot.refreshError,
    refreshErrorMessage: snapshot.refreshErrorMessage, availableModels: [], supportsFreeform: false };
  expect(AgentModelsProbeObservationSchema.parse(models)).toEqual(models);
});

it('retains the producer-resolved opaque model selector identity across config event and metadata roots', () => {
  const modelConfigOptionId = ' native/model-selector= ';
  const event = AgentSessionRuntimeEventV1Schema.parse({ kind: 'config-options', sequence: 1, sessionId: 'session', emittedAtMs: 1,
    modelConfigOptionId, configOptions: [{ id: modelConfigOptionId, name: 'Engine', type: 'select', currentValue: 'native' }] });
  expect(event).toHaveProperty('modelConfigOptionId', modelConfigOptionId);
  if (event.kind !== 'config-options') throw new Error('Expected config catalog event');
  expect(AgentConfigOptionsProbeObservationSchema.parse({ configOptions: event.configOptions, modelConfigOptionId }))
    .toEqual({ configOptions: event.configOptions, modelConfigOptionId });
  const catalog = { v: 1, agentId: 'native', updatedAt: 1, modelConfigOptionId, configOptions: event.configOptions };
  const created = createSessionOwnerMetadataV1({ metadata: { sessionConfigOptionsV1: catalog } });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('Resolved selector rejected');
  expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata: {} }), ownerMetadata: created.ownerMetadata }))
    .toMatchObject({ sessionConfigOptionsV1: catalog });
});

it('carries the complete observed config catalog through the runtime, preflight and owner metadata contracts', () => {
  // FX 0.0.14 session/new, captured 2026-10-27: E-fx-live-probe.md §3.
  const provider = { id: 'provider', name: 'Provider', category: 'model', type: 'select', currentValue: 'codex',
    options: [{ value: 'gateway', name: 'Vercel AI Gateway' }, { value: 'codex', name: 'Codex subscription' }, { value: 'grok', name: 'Grok subscription' }] };
  const fast = { id: 'fast', name: 'Fast Mode', category: 'model', type: 'select', currentValue: 'false',
    options: [{ value: 'false', name: 'off' }, { value: 'true', name: 'on' }] };
  // Constructed neighboring case: opaque native ids and presentation bytes survive grouping.
  const grouped = { id: ' custom/+ = ', name: ' Custom control ', description: ' Keep spacing\n', category: 'model_config', type: 'select', currentValue: ' true ',
    options: [{ value: ' true ', name: ' On ', description: ' Native choice ' }],
    groups: [{ id: ' native/group= ', name: ' Native group ', options: [{ value: ' true ', name: ' On ', description: ' Native choice ' }] }] };
  const emptyValue = { id: 'optional', name: 'Optional control', description: '', type: 'select', currentValue: '',
    options: [{ value: '', name: 'Default', description: '' }, { value: ' ', name: 'Space' }] };
  const configOptions = [provider, fast, grouped, emptyValue];
  const event = AgentSessionRuntimeEventV1Schema.parse({ kind: 'config-options', sequence: 1, sessionId: 'session', emittedAtMs: 1, configOptions });
  expect(event).toMatchObject({ kind: 'config-options', configOptions });
  if (event.kind !== 'config-options') throw new Error('Expected config catalog event');
  const catalog = { v: 1, agentId: 'fx', updatedAt: 1, configOptions: event.configOptions };
  const overrides = { v: 1, updatedAt: 2, overrides: { [grouped.id]: { updatedAt: 2, value: ' ' } } };
  const created = createSessionOwnerMetadataV1({ metadata: { sessionConfigOptionsV1: catalog,
    sessionConfigOptionOverridesV1: overrides,
    sessionModelsV1: { v: 1, agentId: 'fx', updatedAt: 1, currentModelId: 'model', availableModels: [{ id: 'model', name: 'Model', modelOptions: [grouped] }] } } });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('Config catalog rejected');
  expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata: {} }), ownerMetadata: created.ownerMetadata })).toMatchObject({
    sessionConfigOptionsV1: catalog,
    sessionConfigOptionOverridesV1: overrides,
    sessionModelsV1: { availableModels: [{ modelOptions: [grouped] }] },
  });
  const material = { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) } as const;
  for (const accountMode of ['plain', 'e2ee'] as const) {
    const envelope = accountMode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1(created.ownerMetadata)
      : sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: created.ownerMetadata, material, randomBytes: length => new Uint8Array(length).fill(3) });
    const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode, material,
      envelope: parseSessionOwnerMetadataEnvelopeV1(encodeSessionOwnerMetadataEnvelopeV1(envelope)) });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Config catalog unavailable after persistence');
    expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata: {} }), ownerMetadata: opened.ownerMetadata }))
      .toMatchObject({ sessionConfigOptionsV1: catalog, sessionConfigOptionOverridesV1: overrides });
  }
  expect(event.configOptions.map(option => ProbedCatalogOptionSchema.parse(normalizeProbedCatalogOption(option)))).toEqual(configOptions);
  expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, turnId: 'turn' }).success).toBe(false);
  expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, configOptions: [{ ...grouped, groups: [{ ...grouped.groups[0], authority: true }] }] }).success).toBe(false);
  expect(AgentSessionRuntimeEventV1Schema.parse({ ...event, configOptions: [] })).toMatchObject({ configOptions: [] });
});

it('admits priced cache savings while preserving closed usage envelopes and string-key limits', () => {
  const estimate = estimateUsageModelCost('gpt-5.4', { input: 7, output: 3, reasoning: 2, cacheRead: 3, cacheWrite: 0, total: 15 }, bundledUsageModelPriceCatalog)!;
  const event = { kind: 'usage-observed', sequence: 1, sessionId: 'session', emittedAtMs: 1,
    observationId: 'usage', source: 'native', scope: 'turn_delta', cost: {
      reportedUsd: 0, estimatedUsd: estimate.estimatedUsd, currency: 'USD', breakdown: estimate.breakdown } };
  expect(Object.getOwnPropertySymbols(estimate.breakdown!)).toHaveLength(1);
  for (const candidate of [event, JSON.parse(JSON.stringify(event))]) {
    expect(AgentSessionRuntimeEventV1Schema.parse(candidate)).toEqual(JSON.parse(JSON.stringify(event)));
  }
  for (const breakdown of [{ '': 1 }, { ' padded': 1 }, { 'padded ': 1 },
    { ['x'.repeat(LIMITS.usage.breakdownKeyMaxCodeUnits + 1)]: 1 }, { invalid: -1 }, { invalid: '1' },
    { invalid: Infinity }, Object.fromEntries(Array.from({ length: LIMITS.usage.breakdownMaxEntries + 1 }, (_, i) => [`key-${i}`, 1]))]) {
    expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, cost: { ...event.cost, breakdown } }).success).toBe(false);
  }
  const boundary = { ['x'.repeat(LIMITS.usage.breakdownKeyMaxCodeUnits)]: 0,
    ...Object.fromEntries(Array.from({ length: LIMITS.usage.breakdownMaxEntries - 1 }, (_, i) => [`key-${i}`, i])) };
  expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, cost: { ...event.cost, breakdown: boundary } }).success).toBe(true);
  expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, authority: true }).success).toBe(false);
  expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, cost: { ...event.cost, authority: true } }).success).toBe(false);
});

it('retains explicit incomplete native accounting without admitting untyped history evidence', () => {
  const event = { kind: 'usage-observed', sequence: 1, sessionId: 'session', emittedAtMs: 1,
    observationId: 'usage', source: 'native', scope: 'session_cumulative', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 },
    accounting: { nativeSessionId: 'native-session', historyComplete: false } };
  expect(AgentSessionRuntimeEventV1Schema.safeParse(event).success).toBe(true);
  expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, accounting: { ...event.accounting, historyComplete: 'false' } }).success).toBe(false);
});

it('admits the typed native Session accounting witness while keeping its envelope closed', () => {
  const event = { kind: 'usage-observed', sequence: 1, sessionId: 'session', emittedAtMs: 1,
    observationId: 'usage', source: 'native', scope: 'turn_delta', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 },
    accounting: { nativeSessionId: 'native-session', inferenceId: 'native-generation' } };
  expect(AgentSessionRuntimeEventV1Schema.safeParse(event).success).toBe(true);
  expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...event, accounting: { ...event.accounting, path: '/private' } }).success).toBe(false);
});

describe('Agent session VB4 open inputs', () => {
  const configuration = {
    mode: { value: null, updatedAtMs: 11 },
    model: { value: 'sonnet', updatedAtMs: 12 },
    permissionIntent: { value: 'safe-yolo', updatedAtMs: 13 },
    options: {
      allowIndexing: { value: true, updatedAtMs: 14 },
      temperature: { value: 0.2, updatedAtMs: 10 },
      profile: { value: 'fast', updatedAtMs: 9 },
      optional: { value: null, updatedAtMs: 8 },
    },
  } as const;

  it.each(['on', 'off'] as const)('retains the independent native sandbox %s selection', nativeSandbox => {
    expect(AgentSessionConfigurationSnapshotV1Schema.parse({ ...configuration, nativeSandbox }))
      .toHaveProperty('nativeSandbox', nativeSandbox);
  });

  it.each(['explicit', 'inherited'] as const)('preserves %s model-selection provenance through strict configuration readers', selectionSource => {
    const snapshot = { ...configuration, model: { ...configuration.model, selectionSource } };
    expect(AgentSessionConfigurationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(AgentSessionConfigurationUpdateV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...snapshot, model: { ...snapshot.model, selectionSource: 'unknown' },
    }).success).toBe(false);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...snapshot, mode: { ...snapshot.mode, selectionSource },
    }).success).toBe(false);
  });

  it('accepts bounded launch allow/unset data and preserves independent field timestamps', () => {
    expect(AgentLaunchEnvironmentV1Schema.parse({
      values: { AUGMENT_SESSION_AUTH: 'host-authorized-reference' },
      unset: ['AUGGIE_LEGACY_SETTING'],
    })).toEqual({
      values: { AUGMENT_SESSION_AUTH: 'host-authorized-reference' },
      unset: ['AUGGIE_LEGACY_SETTING'],
    });
    expect(AgentSessionConfigurationSnapshotV1Schema.parse(configuration)).toEqual(configuration);
  });

  it('carries the host-stamped workspace-write restriction separately from permission intent', () => {
    const handsOff = { ...configuration, workspaceWrites: 'deny' };
    expect(AgentSessionConfigurationSnapshotV1Schema.parse(handsOff)).toEqual(handsOff);
    expect(AgentSessionConfigurationUpdateV1Schema.parse(handsOff)).toEqual(handsOff);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({ ...configuration, workspaceWrites: 'unknown' }).success).toBe(false);
  });
  it('carries session tool restrictions without accepting an open unlisted policy', () => {
    const confined = { ...configuration, allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny' };
    expect(AgentSessionConfigurationSnapshotV1Schema.parse(confined)).toEqual(confined);
    expect(AgentSessionConfigurationUpdateV1Schema.parse(confined)).toEqual(confined);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({ ...confined, unlistedTools: 'allow' }).success).toBe(false);
  });


  it('accepts an exact Provider binding descriptor only on a configuration update', () => {
    const update = {
      ...configuration,
      providerBinding: {
        connectionId: 'pc_gateway',
        model: { id: 'gpt-5', name: 'GPT-5' },
        upstream: {
          protocol: 'openai-responses',
          normalizedUrl: 'https://provider.example/v1',
          credential: 'apiKey',
        },
        materialization: { v: 1, kind: 'spawnEnv' },
      },
    } as const;

    expect(AgentSessionConfigurationUpdateV1Schema.parse(update)).toEqual(update);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse(update).success).toBe(false);
    expect(AgentSessionConfigurationUpdateV1Schema.safeParse({
      ...update,
      providerBinding: { ...update.providerBinding, connectionId: ' invalid-id ' },
    }).success).toBe(false);
  });

  it('admits canonical MCP launch projections on updates while preserving strict snapshots and policy envelopes', () => {
    const mcpToolPolicy = Object.fromEntries((['default', 'read-only', 'yolo'] as const).map(permissionMode => [permissionMode,
      projectMcpToolLaunchPolicyV1({ policy: { default: 'ask', overrides: { hidden: 'off', approved: 'allow', prompted: 'ask' } },
        snapshot: undefined, permissionMode }),
    ]));
    const update = { ...configuration, mcpToolPolicy };
    expect(AgentSessionConfigurationUpdateV1Schema.parse(update)).toEqual(update);
    expect(AgentSessionConfigurationSnapshotV1Schema.parse(configuration)).toEqual(configuration);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse(update).success).toBe(false);
    expect(AgentSessionConfigurationUpdateV1Schema.parse({ ...configuration, mcpToolPolicy: {} })).toEqual({ ...configuration, mcpToolPolicy: {} });
    const objectNames = projectMcpToolLaunchPolicyV1({ policy: { default: 'ask', overrides: JSON.parse('{"__proto__":"off","constructor":"allow"}') },
      snapshot: undefined, permissionMode: 'default' });
    const objectNameUpdate = { ...configuration, mcpToolPolicy: Object.fromEntries([['__proto__', objectNames], ['constructor', objectNames]]) };
    expect(AgentSessionConfigurationUpdateV1Schema.parse(objectNameUpdate)).toEqual(objectNameUpdate);
    for (const policy of [
      { unlisted: 'off', tools: {} },
      { unlisted: 'ask', tools: { read: 'allow_all' } },
      { unlisted: 'ask', tools: {}, permissions: 'allow' },
      { unlisted: 'ask', tools: { read: { approval: 'allow' } } },
    ]) expect(AgentSessionConfigurationUpdateV1Schema.safeParse({ ...configuration, mcpToolPolicy: { server: policy } }).success).toBe(false);
    expect(AgentSessionConfigurationUpdateV1Schema.safeParse({ ...update, unknownAuthority: true }).success).toBe(false);
  });

  it('accepts only a strict provider-session resume reference in a configuration snapshot', () => {
    const configurationWithResume = {
      ...configuration,
      providerSessionResume: {
        kind: 'provider_session.v1',
        providerSessionId: 'provider-session-1',
      },
    } as const;

    expect(AgentSessionConfigurationSnapshotV1Schema.parse(configurationWithResume)).toEqual(
      configurationWithResume,
    );
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...configuration,
      providerSessionResume: 'provider-session-1',
    }).success).toBe(false);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...configurationWithResume,
      providerSessionResume: {
        ...configurationWithResume.providerSessionResume,
        backendTarget: { kind: 'backend', backendId: 'claude' },
      },
    }).success).toBe(false);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...configurationWithResume,
      providerSessionResume: {
        ...configurationWithResume.providerSessionResume,
        secret: 'must-not-cross-the-v2-boundary',
      },
    }).success).toBe(false);
  });

  it.each(['default', 'read-only', 'safe-yolo', 'yolo', 'plan', null])(
    'accepts the closed canonical permission intent %s',
    (permissionIntent) => {
      expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
        ...configuration,
        permissionIntent: { value: permissionIntent, updatedAtMs: 13 },
      }).success).toBe(true);
    },
  );

  it('rejects aliases, composite options, invalid timestamps, unknown fields, and leaked host-private data', () => {
    let accessorInvoked = false;
    const accessorLaunchEnvironment = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorLaunchEnvironment, 'values', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return { UNSAFE: 'value' };
      },
    });
    accessorLaunchEnvironment.unset = [];
    for (const invalid of [
      { ...configuration, permissionIntent: { value: 'workspace_write', updatedAtMs: 13 } },
      { ...configuration, options: { allowIndexing: { value: [], updatedAtMs: 14 } } },
      { ...configuration, options: { allowIndexing: { value: {}, updatedAtMs: 14 } } },
      { ...configuration, model: { value: 'sonnet', updatedAtMs: -1 } },
      { ...configuration, mode: { value: null, updatedAtMs: 1.5 } },
      { ...configuration, permissionIntent: { value: 'default', updatedAtMs: Number.POSITIVE_INFINITY } },
      { ...configuration, mcpServers: [] },
      { ...configuration, credentials: { token: 'secret' } },
      { ...configuration, rawMetadata: {} },
      { ...configuration, mode: { value: null, updatedAtMs: 11, revision: 1 } },
    ]) {
      expect(AgentSessionConfigurationSnapshotV1Schema.safeParse(invalid).success).toBe(false);
    }
    for (const invalid of [
      { values: { OK: 'yes' }, unset: [], mcpServers: [] },
      { values: { INVALID: { nested: true } }, unset: [] },
      { values: { INVALID: ['nested'] }, unset: [] },
      { values: { OK: 'yes' }, unset: ['OK'] },
      { values: { OK: 'yes' }, unset: ['OK'], rawMetadata: {} },
      { values: { OK: 'yes' }, unset: [undefined] },
      accessorLaunchEnvironment,
    ]) {
      expect(AgentLaunchEnvironmentV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(accessorInvoked).toBe(false);
  });

  it('normalizes configuration before reading its typed fields', () => {
    let accessorInvoked = false;
    const unsafe = { ...configuration, get mode() {
      accessorInvoked = true;
      return configuration.mode;
    } };
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse(unsafe).success).toBe(false);
    expect(AgentSessionConfigurationUpdateV1Schema.safeParse(unsafe).success).toBe(false);
    expect(accessorInvoked).toBe(false);
    const authored = { ...structuredClone(configuration), model: { value: 'sonnet', updatedAtMs: 12 } };
    const parsed = AgentSessionConfigurationSnapshotV1Schema.parse(authored);
    authored.model.value = 'changed';
    expect(parsed.model.value).toBe('sonnet');
  });

  it('does not invent an aggregate bound for generic launch data', () => {
    const formerAggregatePayload = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`ENV_${index}`, 'x'.repeat(220_000)]),
    );
    expect(AgentLaunchEnvironmentV1Schema.safeParse({ values: formerAggregatePayload, unset: [] }).success).toBe(true);
  });
});

describe('AgentRuntimeJsonValueV1Schema', () => {
  it('accepts plain/null-prototype own data and preserves inert prototype-like keys', () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, '__proto__', {
      value: { constructor: 'inert' },
      enumerable: true,
    });

    const parsed = AgentRuntimeJsonValueV1Schema.parse(value);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed as object, '__proto__')).toBe(true);
    expect((parsed as Record<string, unknown>).__proto__).toEqual({ constructor: 'inert' });
  });

  it('rejects accessors, classes, cycles, sparse arrays, and non-JSON values', () => {
    let accessorInvoked = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return 'unsafe';
      },
    });
    class ProviderPayload { value = 'native'; }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = 'present';

    for (const invalid of [
      accessor,
      new ProviderPayload(),
      cyclic,
      sparse,
      { value: undefined },
      { value: 1n },
      { value: () => undefined },
      { value: Symbol('native') },
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(AgentRuntimeJsonValueV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(accessorInvoked).toBe(false);
  });

  it('does not impose an aggregate byte cap without a real boundary', () => {
    const formerAggregateLimit = 1_024 * 1_024;
    expect(AgentRuntimeJsonValueV1Schema.safeParse('x'.repeat(formerAggregateLimit - 2)).success).toBe(true);
    expect(AgentRuntimeJsonValueV1Schema.safeParse('x'.repeat(formerAggregateLimit - 1)).success).toBe(true);
    expect(AgentRuntimeJsonValueV1Schema.safeParse({ ['k'.repeat(257)]: true }).success).toBe(true);
    expect(AgentRuntimeJsonValueV1Schema.safeParse(Array.from({ length: 6 }, () => 'x'.repeat(200_000))).success).toBe(true);
  });

  it('does not invent depth or node quotas below the aggregate byte boundary', () => {
    const nested = (depth: number): unknown => {
      let value: unknown = true;
      for (let index = 0; index < depth; index += 1) value = { value };
      return value;
    };

    expect(AgentRuntimeJsonValueV1Schema.safeParse(nested(25)).success).toBe(true);
    expect(AgentRuntimeJsonValueV1Schema.safeParse(Array.from({ length: 8_192 }, () => true)).success).toBe(true);
  });
});

describe('AgentSessionRuntimeEventV1Schema', () => {
  it('accepts only internally consistent complete runtime activity snapshots', () => {
    const base = { kind: 'runtime-activity-snapshot', sequence: 1, sessionId: 'session-1', emittedAtMs: 1 } as const;

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'active',
      activeCount: 1,
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'active',
      activeCount: 2,
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'idle',
      activeCount: 0,
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'unknown',
      activeCount: 0,
    }).success).toBe(true);

    for (const invalid of [
      { ...base, state: 'active', activeCount: 0 },
      { ...base, state: 'idle', activeCount: 1 },
      { ...base, state: 'unknown', activeCount: 1 },
      { ...base, state: 'active', activeCount: 1, sourceClass: 'agent_detached_task' },
      { ...base, state: 'idle', activeCount: 0, sourceClass: null },
      { ...base, state: 'idle', activeCount: 0, sourceId: 'forged' },
    ]) {
      expect(AgentSessionRuntimeEventV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(AGENT_SESSION_RUNTIME_EVENT_KINDS_V1).toContain('runtime-activity-snapshot');
  });

  it('keeps provider continuation correlation closed and separate from host permission authority', () => {
    const base = { sequence: 1, sessionId: 'session-1', emittedAtMs: 1 };
    const facts = [
      { ...base, kind: 'provider-continuation-registered', continuationId: 'task', parentTurnId: 'first', parentToolCallId: 'tool' },
      { ...base, kind: 'provider-continuation-released', continuationId: 'task' },
      { ...base, kind: 'provider-tool-contexts-released', parentTurnId: 'first', toolCallIds: ['tool'] },
      { ...base, kind: 'turn-start', turnId: 'next', startedBy: 'provider', causedByTurnId: 'first', continuationId: 'task' },
    ];
    for (const fact of facts) {
      expect(AgentSessionRuntimeEventV1Schema.safeParse(fact).success).toBe(true);
      expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...fact, permissionMode: 'yolo' }).success).toBe(false);
    }
    const start = facts[3]!;
    expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...start, startedBy: 'host' }).success).toBe(false);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...start, causedByTurnId: undefined }).success).toBe(false);
  });

  it('has one strict stable replacement for every retained current event fact', () => {
    const base = { sequence: 1, sessionId: 'session-1', emittedAtMs: 1 } as const;
    const turn = { ...base, turnId: 'turn-1' } as const;
    const fixtures: readonly Record<string, unknown>[] = [
      { ...turn, kind: 'message-delta', channel: 'assistant', text: 'delta' },
      { ...turn, kind: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: null },
      { ...turn, kind: 'tool-progress', toolCallId: 'tool-1', progress: { percent: 0.5 } },
      { ...turn, kind: 'tool-result', toolCallId: 'tool-1', output: { ok: true } },
      { ...turn, kind: 'turn-start', startedBy: 'host' },
      { ...turn, kind: 'turn-progress' },
      { ...turn, kind: 'turn-complete' },
      { ...turn, kind: 'turn-failed', diagnostic },
      { ...turn, kind: 'turn-cancelled', cause: 'user' },
      { ...turn, kind: 'turn-agent-id-observed', agentTurnId: 'native-turn-1' },
      { ...base, kind: 'transcript-message-committed', messageId: 'message-1', role: 'user', text: 'hello' },
      {
        ...turn,
        kind: 'turn-rollback-boundary',
        agentRollbackOrdinal: 3,
        providerCheckpoint: { promptIndex: 7 },
      },
      { ...base, kind: 'runtime-ended', cause: 'providerEnded', retryable: false },
      { ...base, kind: 'provider-session-id', providerSessionId: 'native-session-1' },
      {
        ...base,
        kind: 'available-commands',
        commands: [{ name: '/goal', description: 'Set a session goal' }],
      },
      { ...turn, kind: 'file-edit', editId: 'edit-1', path: '/tmp/file', diff: '+hello' },
      { ...base, kind: 'usage-observed', observationId: 'usage-1', source: 'provider', scope: 'session_final', tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } },
      { ...base, kind: 'context-compaction', compactionId: 'compact-1', trigger: 'automatic', phase: 'completed' },
    ];

    for (const fixture of fixtures) {
      expect(AgentSessionRuntimeEventV1Schema.safeParse(fixture), String(fixture.kind)).toMatchObject({ success: true });
    }
  });

  it('preserves complete tool payloads beyond the former aggregate candidate ceiling', () => {
    const base = { sequence: 1, sessionId: 'session-1', emittedAtMs: 1, turnId: 'turn-1' } as const;
    const text = 'é'.repeat(1_250_001);
    for (const event of [
      { ...base, kind: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: { text } },
      { ...base, kind: 'tool-progress', toolCallId: 'tool-1', progress: { text } },
      { ...base, kind: 'tool-result', toolCallId: 'tool-1', output: { text } },
    ]) {
      expect(AgentSessionRuntimeEventV1Schema.parse(event)).toEqual(event);
    }
  });

  it('rejects provider checkpoints larger than the canonical turn checkpoint limit', () => {
    const oversizedCheckpoint = 'x'.repeat(4_097);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      kind: 'turn-rollback-boundary',
      turnId: 'turn-1',
      providerCheckpoint: oversizedCheckpoint,
    }).success).toBe(false);
    expect(AgentSessionConversationRollbackRequestV1Schema.safeParse({
      operationId: 'rollback-1',
      target: { kind: 'beforeTurn', turnId: 'turn-1' },
      affectedTurns: [{
        turnId: 'turn-1',
        providerCheckpoint: oversizedCheckpoint,
      }],
      providerSessionId: 'provider-session-1',
      runtimeIncarnationId: 'runtime-1',
    }).success).toBe(false);
  });

  it('rejects every host-derived or retired current event writer', () => {
    const base = { sequence: 1, sessionId: 'session-1', emittedAtMs: 1 } as const;
    for (const kind of [
      'turn-input-appended',
      'transcript-user-text',
      'transcript-agent-message-committed',
      'turn-rollback-boundary-observed',
      'turn-rollback-applied',
      'session-ended',
      'runtime-status-change',
      'session-id-publish',
      'descriptor-update',
      'diff-emit',
      'backend-error',
      'token-count',
      'subagent-start',
      'subagent-status-change',
      'subagent-end',
    ]) {
      expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...base, kind }).success, kind).toBe(false);
    }
  });

  it('accepts the strict provider-neutral lifecycle and product facts', () => {
    expect(AgentSessionRuntimeEventV1Schema.parse({
      kind: 'message-delta',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      turnId: 'turn-1',
      channel: 'assistant',
      text: 'hello',
    })).toMatchObject({ kind: 'message-delta', text: 'hello' });

    expect(AgentSessionRuntimeEventV1Schema.parse({
      kind: 'context-compaction',
      sequence: 2,
      sessionId: 'session-1',
      emittedAtMs: 2,
      compactionId: 'compaction-1',
      trigger: 'manual',
      phase: 'outcomeUnknown',
      diagnostic,
    })).toMatchObject({ kind: 'context-compaction', phase: 'outcomeUnknown' });

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'input-accepted',
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 3,
      inputIds: ['input-1'],
      delivery: { kind: 'followUp', turnId: 'turn-2' },
    }).success).toBe(true);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'input-accepted',
      sequence: 4,
      sessionId: 'session-1',
      emittedAtMs: 4,
      inputIds: ['input-1'],
      delivery: { kind: 'followUp', turnId: 'turn-2', afterTurnId: 'plugin-echo' },
    }).success).toBe(false);
  });

  it('rejects retired writers, unknown fields, and fields on the wrong branch', () => {
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'backend-error',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      error: { message: 'native payload' },
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'turn-complete',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      turnId: 'turn-1',
      summary: { native: true },
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'usage-observed',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      observationId: 'observation-1',
      source: 'provider',
      scope: 'turn_delta',
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      sidechainId: 'not-legal-here',
    }).success).toBe(false);

    const inference = {
      kind: 'usage-observed', sequence: 1, sessionId: 'session-1', emittedAtMs: 1,
      observationId: 'observation-1', source: 'provider', scope: 'turn_delta',
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      accounting: { nativeSessionId: 'native-session', inferenceId: 'native-generation', inputIncludesCache: true, outputIncludesReasoning: true },
    };
    expect(AgentSessionRuntimeEventV1Schema.safeParse(inference).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...inference, accounting: { ...inference.accounting, path: '/private/path' },
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'file-edit',
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 3,
      turnId: 'turn-1',
      editId: 'edit-1',
      path: '/tmp/file',
      oldContent: 'x'.repeat(1_000_000),
      newContent: 'y'.repeat(1_000_000),
    }).success).toBe(true);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'usage-observed',
      sequence: 4,
      sessionId: 'session-1',
      emittedAtMs: 4,
      observationId: 'usage-1',
      source: 'provider',
      scope: 'turn_delta',
      cost: {
        reportedUsd: 0,
        estimatedUsd: 0,
        currency: 'USD',
        breakdown: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key-${index}`, 1])),
      },
    }).success).toBe(false);
  });

  it('enforces stable exact bounds and spellings without trimming identifiers', () => {
    const base = {
      kind: 'message-delta',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      turnId: 'turn-1',
      channel: 'assistant',
    } as const;

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      text: 'x'.repeat(65_536),
      sidechainId: 's'.repeat(191),
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      text: 'x'.repeat(65_537),
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      text: 'x'.repeat(2_500_001),
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      text: 'ok',
      sidechainId: 's'.repeat(192),
    }).success).toBe(false);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      sessionId: ' session-1',
      text: 'ok',
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'context-compaction',
      sequence: 2,
      sessionId: 'session-1',
      emittedAtMs: 2,
      compactionId: 'compaction-1',
      trigger: 'auto',
      phase: 'completed',
    }).success).toBe(false);

    const usageBase = {
      kind: 'usage-observed',
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 3,
      observationId: 'usage-1',
      source: 'provider',
      scope: 'turn_delta',
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
      },
    } as const;
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...usageBase,
      modelId: 'm'.repeat(512),
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...usageBase,
      modelId: 'm'.repeat(513),
    }).success).toBe(false);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...usageBase,
      modelId: ' model-1',
    }).success).toBe(false);
  });
});

describe('conversation rollback wire schemas', () => {
  const request = {
    operationId: 'rollback-1',
    target: { kind: 'beforeTurn', turnId: 'turn-1' },
    affectedTurns: [
      { turnId: 'turn-1', providerCheckpoint: 'provider-turn-1' },
      { turnId: 'turn-2', providerCheckpoint: { promptIndex: 7 } },
    ],
    providerSessionId: 'provider-session-1',
    runtimeIncarnationId: 'runtime-1',
  } as const;

  it('accepts the exact host-resolved attempt and provider-authoritative result', () => {
    expect(AgentSessionConversationRollbackRequestV1Schema.parse(request)).toMatchObject(request);
    expect(AgentSessionConversationRollbackReconciliationResultV1Schema.parse({
      status: 'notApplied',
    })).toEqual({ status: 'notApplied' });
  });

  it('rejects duplicate/over-bound affected turns and provider-selected extras', () => {
    expect(AgentSessionConversationRollbackRequestV1Schema.safeParse({
      ...request,
      affectedTurns: [{ turnId: 'turn-1' }, { turnId: 'turn-1' }],
    }).success).toBe(false);
    expect(AgentSessionConversationRollbackRequestV1Schema.safeParse({
      ...request,
      affectedTurns: Array.from({ length: 4_097 }, (_, index) => ({ turnId: `turn-${index}` })),
    }).success).toBe(false);
    expect(AgentSessionConversationRollbackReconciliationResultV1Schema.safeParse({
      status: 'applied',
      affectedTurns: [{ turnId: 'provider-chosen' }],
    }).success).toBe(false);
  });
});

describe('AgentSessionSendRequestV1Schema', () => {
  it('preserves the optional native output schema while keeping the input envelope closed', () => {
    const request = { inputIds: ['native-output'], delivery: { kind: 'newTurn', turnId: 'turn-schema' },
      input: { text: 'Review the code', outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } };
    expect(AgentSessionSendRequestV1Schema.parse(request)).toEqual(request);
    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request,
      input: { ...request.input, unsupportedOutputAuthority: true } }).success).toBe(false);
  });
  it('preserves nonblank opaque input ids across send and custody evidence', () => {
    const opaqueInputId = ' input-opaque ';
    const sendRequest = AgentSessionSendRequestV1Schema.safeParse({
      inputIds: [opaqueInputId],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-opaque' },
    });
    expect(sendRequest.success).toBe(true);
    if (sendRequest.success) {
      expect(sendRequest.data.inputIds).toEqual([opaqueInputId]);
    }
    expect(AgentSessionSendRequestV1Schema.safeParse({
      inputIds: [opaqueInputId, 'input-opaque'],
      input: { text: 'distinct ids' },
      delivery: { kind: 'newTurn', turnId: 'turn-distinct' },
    }).success).toBe(true);

    const acceptance = AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'input-accepted',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      inputIds: [opaqueInputId],
      delivery: { kind: 'newTurn', turnId: 'turn-opaque' },
    });
    expect(acceptance.success).toBe(true);
    if (acceptance.success) {
      expect(acceptance.data.inputIds).toEqual([opaqueInputId]);
    }

    expect(AgentSessionSendRequestV1Schema.safeParse({
      inputIds: ['   '],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-blank' },
    }).success).toBe(false);
  });

  it('accepts one atomic duplicate-free host-issued input tuple', () => {
    expect(AgentSessionSendRequestV1Schema.parse({
      inputIds: ['input-1', 'input-2'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).toMatchObject({ inputIds: ['input-1', 'input-2'] });

    expect(AgentSessionSendRequestV1Schema.safeParse({
      inputIds: ['input-3'],
      input: { text: 'follow up' },
      delivery: { kind: 'followUp', turnId: 'turn-2', afterTurnId: 'turn-1' },
    }).success).toBe(true);
  });

  it('carries only a strict admitted-input causal permission authority', () => {
    const request = {
      inputIds: ['input-causal'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn' as const, turnId: 'turn-causal' },
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'read-only' as const,
      },
    };
    expect(AgentSessionSendRequestV1Schema.safeParse(request)).toMatchObject({
      success: true,
      data: { causalPermissionAuthority: request.causalPermissionAuthority },
    });
    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      causalPermissionAuthority: {
        ...request.causalPermissionAuthority,
        admittedPermissionCeiling: 'not-a-permission-mode',
      },
    }).success).toBe(false);
  });

  it('rejects empty, duplicate, oversized, and unknown request data', () => {
    const request = {
      inputIds: ['input-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    } as const;

    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, inputIds: [] }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, inputIds: ['input-1', 'input-1'] }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, inputIds: Array.from({ length: 513 }, (_, index) => `input-${index}`) }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, authorSelectedId: 'forbidden' }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      delivery: { kind: 'followUp', turnId: 'turn-2' },
    }).success).toBe(false);
  });

  it('rejects non-plain structured JSON values without imposing the removed aggregate cap', () => {
    class ProviderPayload {
      value = 'native';
    }
    const request = {
      inputIds: ['input-1'],
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    } as const;

    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      input: { text: 'hello', structuredInput: new ProviderPayload() },
    }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      input: { text: 'hello', structuredInput: 'x'.repeat(1_024 * 1_024) },
    }).success).toBe(true);
  });
});
