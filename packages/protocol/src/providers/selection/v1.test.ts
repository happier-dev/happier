import { describe, expect, it } from 'vitest';

import {
  applyProviderDefaultModelSelectionV1,
  readAgentDefaultModelSelectionV1,
  ProviderBoundModelRefSchema,
  SessionActiveModelSelectionV1Schema,
  SessionAppliedModelV1Schema,
  SessionModelSelectionV1Schema,
  ModelVisibilityRefV1Schema,
  deserializeSessionModelSelectionV1,
  deserializeModelVisibilityRefV1,
  resolveSessionModelSelectionInputRefV1,
  resolveSessionModelSelectionIntentV1,
  readSessionModelSelectionIntentSourceV1,
  sessionModelSelectionIntentRequiresAgentTargetV1,
  SessionModelSelectionIntentV1Schema,
  projectSessionMessageModelSelectionToLegacyModelV1,
  projectSessionModelSelectionIntentToLegacyModelOverrideV1,
  readSessionMessageModelSelectionV1,
  SessionModelSelectionResolutionError,
  serializeSessionModelSelectionV1,
  serializeModelVisibilityRefV1,
  withSessionMessageModelSelectionV1,
} from './v1.js';
import { readExactSessionActiveModelSelectionV1 } from './activeSelectionValidationV1.js';
import { createProviderBindingSecurityFingerprintV1 } from '../securityFingerprintsV1.js';
import { SessionModelSelectionV2Schema } from './v2.js';

describe('provider model selection contracts', () => {
  it('preserves opaque native model bytes through flat selection and legacy metadata without weakening Provider ids', () => {
    for (const modelId of [' native/model ', ' default ']) {
      const expected = { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId };
      expect(resolveSessionModelSelectionInputRefV1({ agentTargetKey: 'agent:codex', modelId })).toEqual(expected);
      expect(resolveSessionModelSelectionIntentV1({ canonical: undefined, legacy: { v: 1, updatedAt: 1, modelId },
        agentTargetKey: 'agent:codex' })?.selection).toEqual(expected);
      expect(ProviderBoundModelRefSchema.safeParse({ ...expected, providerConnectionId: 'pc_work' }).success).toBe(false);
      expect(SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 1,
        ref: { source: 'native', agentTargetKey: expected.agentTargetKey, modelId } }).ref.modelId).toBe(modelId);
      expect(SessionModelSelectionV2Schema.safeParse({ v: 2, updatedAt: 1,
        ref: { source: 'account_provider_connection', ...expected, providerConnectionId: 'pc_work' } }).success).toBe(false);
    }
  });
  it('reads retained canonical model intent without letting retired keys select the legacy fallback', () => {
    const intent = { v: 1, selection: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_one', modelId: 'model/a' }, updatedAt: 1 };
    const annotated = { ...intent, retired: true, selection: { ...intent.selection, retired: true } };
    expect(readSessionModelSelectionIntentSourceV1({ canonical: annotated, legacy: undefined }))
      .toEqual({ status: 'canonical', intent });
    expect(readSessionModelSelectionIntentSourceV1({ canonical: { ...annotated, updatedAt: -1 }, legacy: undefined }))
      .toEqual({ status: 'invalid' });
    expect(SessionModelSelectionIntentV1Schema.safeParse(annotated).success).toBe(false);
  });
  it('edits one default while projecting retired fields in the retained selections', () => {
    const selection = { v: 1, ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_one', modelId: 'model/a' }, updatedAt: 1 };
    const raw = { providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:codex': { ...selection, retired: true,
      ref: { ...selection.ref, retired: true } } } };
    expect(applyProviderDefaultModelSelectionV1(raw, { agentTargetKey: 'agent:claude', selection: null }))
      .toEqual({ providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:codex': selection } });
  });
  it('joins active model proof to the exact current runner and rejects fallback or mismatched binding facts', () => {
    const runtime = {
      v: 1,
      sessionId: 'session-1',
      machineId: 'machine-1',
      daemonId: 'daemon-1',
      observedAtMs: 1,
      runner: {
        pid: 123,
        processStartTimeMs: 1_000,
        runtimeId: 'runner-generation-1',
        cliVersion: '1.0.0',
        entrypointVersion: '1.0.0',
        processCommandHash: 'command-hash',
        entrypointSource: 'launch_spec',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        cliVersion: '1.0.0',
        startedWithCliVersion: '1.0.0',
        currentEntrypointVersion: 'runner-generation-1',
        currentEntrypointSource: 'launch_spec',
      },
      versionState: 'current',
      statusSource: 'daemon_tracking',
      plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
      },
    } as const;
    const activeSelectionV1 = {
      v: 1,
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'native-model',
      },
      source: 'runtime_apply',
      runner: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    } as const;
    const metadata = {
      sessionRunnerRuntimeV1: runtime,
      sessionModelsV1: {
        v: 1,
        agentId: 'qwen',
        updatedAt: 1,
        currentModelId: 'native-model',
        availableModels: [{ id: 'native-model', name: 'Native model' }],
        activeSelectionV1,
      },
    };

    expect(readExactSessionActiveModelSelectionV1({
      metadata,
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    })).toEqual(activeSelectionV1);
    const {
      sessionRunnerRuntimeV1: _unusedRuntimeStatus,
      ...metadataWithoutRuntimeStatus
    } = metadata;
    expect(readExactSessionActiveModelSelectionV1({
      metadata: metadataWithoutRuntimeStatus,
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    })).toEqual(activeSelectionV1);
    expect(readExactSessionActiveModelSelectionV1({
      metadata,
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: null,
    })).toBeNull();
    expect(readExactSessionActiveModelSelectionV1({
      metadata: {
        ...metadata,
        sessionRunnerRuntimeV1: {
          ...runtime,
          daemonId: 'replacement-daemon',
        },
      },
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    })).toEqual(activeSelectionV1);
    expect(readExactSessionActiveModelSelectionV1({
      metadata: {
        ...metadata,
        sessionRunnerRuntimeV1: {
          ...runtime,
          runner: {
            ...runtime.runner,
            runtimeId: 'runner-generation-2',
          },
        },
      },
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    })).toEqual(activeSelectionV1);
    expect(readExactSessionActiveModelSelectionV1({
      metadata: {
        ...metadata,
        sessionRunnerRuntimeV1: {
          ...runtime,
          runner: {
            ...runtime.runner,
            pid: 124,
            processStartTimeMs: 2_000,
          },
        },
      },
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: {
        pid: 124,
        processStartTimeMs: 2_000,
      },
    })).toBeNull();
    expect(readExactSessionActiveModelSelectionV1({
      metadata: {
        ...metadata,
        providerBindingV1: {
          connectionId: 'pc_wrong',
        },
      },
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    })).toBeNull();
    expect(readExactSessionActiveModelSelectionV1({
      metadata: {
        ...metadata,
        sessionModelsV1: {
          ...metadata.sessionModelsV1,
          activeSelectionV1: undefined,
        },
      },
      agentId: 'qwen',
      agentTargetKey: 'backend:qwen',
      currentRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    })).toBeNull();
  });

  it('accepts Provider-bound active proof only when every persisted runtime-basis dimension is coherent', () => {
    const runtimeBindingBasis = {
      v: 1,
      deployment: { kind: 'external' },
      agentTargetKey: 'backend:codex',
      connectionId: 'pc_work',
      contributionKey: 'plugin.openrouter/openrouter',
      endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://provider.example/v1',
        protocol: 'openai-responses',
        publicHeaders: { 'x-provider': 'openrouter' },
      },
      runtimeCredentialTransport: {
        id: 'runtime-bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'authorization',
          format: 'bearer',
        },
      },
      prepared: {
        v: 1,
        materialization: 'engineConfig',
        adapterBindingKey: 'openrouter',
      },
      adapterVersion: 1,
      credentialAuthorization: {
        connectionSecurityFingerprint: 'connection-security-v1',
        grantFingerprint: 'grant-v1',
        selectedSecretBindingId: 'binding-v1',
        selectedSecretRecordFingerprint: 'record-v1',
      },
      agentSupport: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: {
          supportsNoAuth: false,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: {
              kind: 'httpHeader',
              names: ['authorization'],
              formats: ['bearer'],
            },
          }],
        },
        authIsolation: {
          suppressConnectedServiceIds: [],
          ownedEnvKeys: ['OPENAI_API_KEY'],
        },
        materialization: 'engineConfig',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
    } as const;
    const model = {
      id: 'openrouter/model',
      name: 'Provider model',
      capabilities: { reasoningControls: 'supported' as const },
    };
    const bindingSecurityFingerprint =
      createProviderBindingSecurityFingerprintV1({
        agentTargetKey: runtimeBindingBasis.agentTargetKey,
        connectionId: runtimeBindingBasis.connectionId,
        modelId: model.id,
        modelCapabilities: model.capabilities,
        endpointTemplateId: runtimeBindingBasis.endpoint.endpointTemplateId,
        endpointUrl: runtimeBindingBasis.endpoint.normalizedUrl,
        protocol: runtimeBindingBasis.endpoint.protocol,
        publicHeaders: runtimeBindingBasis.endpoint.publicHeaders,
        materialization: runtimeBindingBasis.prepared.materialization,
        adapterBindingKey: runtimeBindingBasis.prepared.adapterBindingKey,
        credentialDestination:
          runtimeBindingBasis.runtimeCredentialTransport.destination,
        compatibilityFingerprint: 'compatibility-v1',
        adapterVersion: runtimeBindingBasis.adapterVersion,
      });
    const activeSelectionV1 = {
      v: 1,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: model.id,
      },
      source: 'runtime_apply',
      runner: { pid: 123, processStartTimeMs: 1_000 },
    } as const;
    const providerBindingV1 = {
      v: 1,
      connectionId: 'pc_work',
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 3,
      model,
      protocol: 'openai-responses',
      materialization: 'engineConfig',
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint,
      runtimeBindingBasis,
      displaySnapshot: {
        providerName: 'OpenRouter',
        connectionName: 'Work',
        connectionRole: 'named',
        connectionDisplayNameMode: 'custom',
      },
    } as const;
    const metadata = {
      providerBindingV1,
      sessionModelsV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 1,
        currentModelId: model.id,
        availableModels: [model],
        activeSelectionV1,
      },
    };
    const read = (binding: unknown) =>
      readExactSessionActiveModelSelectionV1({
        metadata: { ...metadata, providerBindingV1: binding },
        agentId: 'codex',
        agentTargetKey: 'backend:codex',
        currentRunnerProcessIdentity: {
          pid: 123,
          processStartTimeMs: 1_000,
        },
      });

    expect(read(providerBindingV1)).toEqual(activeSelectionV1);
    // Private Provider catalogs can be unverified while an admitted runner has
    // already observed its exact model. Membership is not execution evidence.
    for (const availableModels of [[], [{ id: 'other-model', name: 'Other model' }]]) {
      expect(readExactSessionActiveModelSelectionV1({
        metadata: { ...metadata, sessionModelsV1: { ...metadata.sessionModelsV1, availableModels } },
        agentId: 'codex', agentTargetKey: 'backend:codex',
        currentRunnerProcessIdentity: activeSelectionV1.runner,
      })).toEqual(activeSelectionV1);
    }
    for (const incoherent of [
      { ...providerBindingV1, contributionKey: null },
      { ...providerBindingV1, protocol: 'anthropic' },
      { ...providerBindingV1, materialization: 'spawnEnv' },
      { ...providerBindingV1, adapterBindingKey: undefined },
      { ...providerBindingV1, compatibilityFingerprint: 'stale' },
      { ...providerBindingV1, bindingSecurityFingerprint: 'stale' },
    ]) {
      expect(read(incoherent)).toBeNull();
    }
  });

  it('requires exact runtime provenance for an active structured model selection', () => {
    expect(SessionActiveModelSelectionV1Schema.parse({
      v: 1,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'openrouter/model',
      },
      source: 'runtime_apply',
      runner: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    })).toEqual({
      v: 1,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'openrouter/model',
      },
      source: 'runtime_apply',
      runner: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    });
    expect(SessionActiveModelSelectionV1Schema.safeParse({
      v: 1,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'native-model',
      },
      source: 'runtime_apply',
      runner: {
        pid: 123,
        processStartTimeMs: null,
      },
    }).success).toBe(false);
  });

  it('accepts the Remote Dev applied-model fact and the structured Dev extension', () => {
    expect(SessionAppliedModelV1Schema.parse({
      v: 1,
      provider: 'codex',
      updatedAt: 41,
      modelId: 'gpt-5.6-terra',
    })).toEqual({
      v: 1,
      provider: 'codex',
      updatedAt: 41,
      modelId: 'gpt-5.6-terra',
    });

    expect(SessionAppliedModelV1Schema.parse({
      v: 1,
      provider: 'codex',
      updatedAt: 42,
      modelId: 'openrouter/model',
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'openrouter/model',
      },
    })).toMatchObject({
      modelId: 'openrouter/model',
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'openrouter/model',
      },
    });
  });

  it('treats default as Automatic only without a provider connection', () => {
    expect(resolveSessionModelSelectionInputRefV1({
      agentTargetKey: 'agent:codex',
      providerConnectionId: null,
      modelId: 'default',
    })).toBeNull();
    expect(resolveSessionModelSelectionInputRefV1({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_work',
      modelId: 'default',
    })).toEqual({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_work',
      modelId: 'default',
    });
  });

  it('rejects a provider connection without a concrete model id', () => {
    expect(() => resolveSessionModelSelectionInputRefV1({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_work',
      modelId: '   ',
    })).toThrow();
  });

  it('keeps provider connection identity separate from exact model punctuation', () => {
    const ref = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_1',
      modelId: 'Vendor/Model:Preview',
    });
    expect(ref.modelId).toBe('Vendor/Model:Preview');
  });

  it('uses a collision-safe visibility key and makes native all-agent visibility impossible', () => {
    const ref = ModelVisibilityRefV1Schema.parse({
      scope: 'allAgents',
      providerConnectionId: 'pc:1/slash',
      modelId: 'vendor/model:latest',
    });
    const key = serializeModelVisibilityRefV1(ref);
    expect(key).toMatch(/^mvr1:/);
    expect(deserializeModelVisibilityRefV1(key)).toEqual(ref);
    expect(ModelVisibilityRefV1Schema.safeParse({ scope: 'allAgents', providerConnectionId: null, modelId: 'x' }).success).toBe(false);
  });

  it('rejects non-canonical agent identities rather than rewriting persisted refs', () => {
    expect(ProviderBoundModelRefSchema.safeParse({
      agentTargetKey: ' agent:codex ', providerConnectionId: null, modelId: 'gpt-5',
    }).success).toBe(false);
  });

  it('rejects padded and decoder-permissive aliases of one canonical visibility key', () => {
    const key = serializeModelVisibilityRefV1({
      scope: 'allAgents', providerConnectionId: 'pc_1', modelId: 'model-a',
    });
    const aliases = [
      `${key}=`,
      `${key.slice(0, 8)} ${key.slice(8)}`,
      `${key.slice(0, 8)}!${key.slice(8)}`,
    ];
    for (const alias of aliases) expect(() => deserializeModelVisibilityRefV1(alias)).toThrowError('Invalid model visibility key');
  });

  it('resolves canonical and legacy timestamped model intent with canonical tie precedence', () => {
    const selected = {
      v: 1,
      updatedAt: 20,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'default' },
    } as const;
    expect(resolveSessionModelSelectionIntentV1({
      canonical: selected,
      legacy: { v: 1, updatedAt: 20, modelId: null },
      agentTargetKey: 'agent:codex',
    })).toEqual(selected);
    expect(SessionModelSelectionIntentV1Schema.parse(selected)).toEqual(selected);
  });

  it('keeps clear/reset ordering while treating magic default only on the legacy boundary', () => {
    expect(resolveSessionModelSelectionIntentV1({
      canonical: {
        v: 1,
        updatedAt: 10,
        selection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'native-model' },
      },
      legacy: { v: 1, updatedAt: 11, modelId: 'default' },
      agentTargetKey: 'agent:codex',
    })).toEqual({ v: 1, updatedAt: 11, selection: null });
    expect(resolveSessionModelSelectionIntentV1({
      canonical: { v: 1, updatedAt: 12, selection: null },
      legacy: { v: 1, updatedAt: 11, modelId: 'native-old' },
      agentTargetKey: 'agent:codex',
    })).toEqual({ v: 1, updatedAt: 12, selection: null });
  });

  it('never lets newer legacy intent downgrade a canonical Provider-bound selection', () => {
    const providerBound = {
      v: 1,
      updatedAt: 10,
      selection: {
        agentTargetKey: 'agent:codex',
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
    } as const;

    for (const legacy of [
      { v: 1, updatedAt: 11, modelId: 'default' },
      { v: 1, updatedAt: 12, modelId: 'native-model' },
    ] as const) {
      expect(sessionModelSelectionIntentRequiresAgentTargetV1({
        canonical: providerBound,
        legacy,
      })).toBe(true);
      expect(resolveSessionModelSelectionIntentV1({
        canonical: providerBound,
        legacy,
        agentTargetKey: 'agent:codex',
      })).toEqual(providerBound);
    }

    expect(() => resolveSessionModelSelectionIntentV1({
      canonical: {
        ...providerBound,
        selection: {
          ...providerBound.selection,
          agentTargetKey: 'agent:claude',
        },
      },
      legacy: { v: 1, updatedAt: 12, modelId: 'native-model' },
      agentTargetKey: 'agent:codex',
    })).toThrowError(expect.objectContaining({
      code: 'model_selection_agent_target_mismatch',
    }));
  });

  it('maps legacy models to native refs and rejects canonical refs for another agent target', () => {
    expect(resolveSessionModelSelectionIntentV1({
      canonical: undefined,
      legacy: { v: 1, updatedAt: 9, modelId: 'legacy/model' },
      agentTargetKey: 'agent:codex',
    })).toEqual({
      v: 1,
      updatedAt: 9,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'legacy/model' },
    });
    expect(() => resolveSessionModelSelectionIntentV1({
      canonical: {
        v: 1,
        updatedAt: 10,
        selection: { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'x' },
      },
      legacy: undefined,
      agentTargetKey: 'agent:codex',
    })).toThrowError(expect.objectContaining({
      code: 'model_selection_agent_target_mismatch',
    }));
    expect(() => resolveSessionModelSelectionIntentV1({
      canonical: undefined,
      legacy: { v: 1, updatedAt: 9, modelId: 'legacy/model' },
      agentTargetKey: '',
    })).toThrowError(expect.objectContaining({
      code: 'model_selection_agent_target_unknown',
    }));
    expect(SessionModelSelectionResolutionError).toBeTypeOf('function');
  });

  it('preserves legacy native model ids and rejects blank native or malformed Provider ids', () => {
    expect(resolveSessionModelSelectionIntentV1({
      canonical: undefined,
      legacy: { v: 1, updatedAt: 9, modelId: ' legacy/model ' },
      agentTargetKey: 'agent:codex',
    })).toEqual({
      v: 1,
      updatedAt: 9,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: ' legacy/model ' },
    });

    const canonical = {
      v: 1,
      updatedAt: 8,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'canonical-model' },
    } as const;
    expect(resolveSessionModelSelectionIntentV1({
      canonical,
      legacy: { v: 1, updatedAt: 10, modelId: 'invalid legacy model' },
      agentTargetKey: 'agent:codex',
    })).toEqual(canonical);
    expect(resolveSessionModelSelectionIntentV1({
      canonical: undefined,
      legacy: { v: 1, updatedAt: 10, modelId: '   ' },
      agentTargetKey: 'agent:codex',
    })).toBeNull();

    expect(SessionModelSelectionIntentV1Schema.safeParse({
      v: 1,
      updatedAt: 10,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'invalid current model' },
    }).success).toBe(true);
    expect(SessionModelSelectionIntentV1Schema.safeParse({
      v: 1, updatedAt: 10,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'invalid current model' },
    }).success).toBe(false);
  });

  it('owns target-requirement decisions across legacy normalization and canonical precedence', () => {
    for (const modelId of ['default', '   ']) {
      expect(sessionModelSelectionIntentRequiresAgentTargetV1({
        canonical: undefined,
        legacy: { v: 1, updatedAt: 10, modelId },
      })).toBe(false);
    }
    for (const modelId of [' default ', 'native model with spaces']) {
      expect(sessionModelSelectionIntentRequiresAgentTargetV1({
        canonical: undefined,
        legacy: { v: 1, updatedAt: 10, modelId },
      })).toBe(true);
    }

    expect(sessionModelSelectionIntentRequiresAgentTargetV1({
      canonical: { v: 1, updatedAt: 11, selection: null },
      legacy: { v: 1, updatedAt: 10, modelId: 'vendor/model' },
    })).toBe(false);
    expect(sessionModelSelectionIntentRequiresAgentTargetV1({
      canonical: { v: 1, updatedAt: 9, selection: null },
      legacy: { v: 1, updatedAt: 10, modelId: 'vendor/model' },
    })).toBe(true);
  });

  it('validates target identity only for the effective timestamped source', () => {
    const staleCanonical = {
      v: 1,
      updatedAt: 9,
      selection: { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'stale-model' },
    } as const;
    const newerLegacyClear = { v: 1, updatedAt: 10, modelId: null } as const;

    expect(sessionModelSelectionIntentRequiresAgentTargetV1({
      canonical: staleCanonical,
      legacy: newerLegacyClear,
    })).toBe(false);
    expect(resolveSessionModelSelectionIntentV1({
      canonical: staleCanonical,
      legacy: newerLegacyClear,
      agentTargetKey: 'agent:codex',
    })).toEqual({ v: 1, updatedAt: 10, selection: null });
    expect(resolveSessionModelSelectionIntentV1({
      canonical: staleCanonical,
      legacy: newerLegacyClear,
      agentTargetKey: '',
    })).toEqual({ v: 1, updatedAt: 10, selection: null });
    expect(resolveSessionModelSelectionIntentV1({
      canonical: undefined,
      legacy: undefined,
      agentTargetKey: '',
    })).toBeNull();

    const newerLegacyModel = { v: 1, updatedAt: 11, modelId: 'newer-model' } as const;
    expect(sessionModelSelectionIntentRequiresAgentTargetV1({
      canonical: staleCanonical,
      legacy: newerLegacyModel,
    })).toBe(true);
    expect(resolveSessionModelSelectionIntentV1({
      canonical: staleCanonical,
      legacy: newerLegacyModel,
      agentTargetKey: 'agent:codex',
    })).toEqual({
      v: 1,
      updatedAt: 11,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'newer-model' },
    });
  });

  it('treats a null canonical carrier as present-invalid, never as absent legacy deference', () => {
    const newerLegacy = { v: 1, updatedAt: 999, modelId: 'gpt-5' } as const;

    // undefined stays absent: a newer usable legacy override is the intent.
    expect(readSessionModelSelectionIntentSourceV1({
      canonical: undefined,
      legacy: newerLegacy,
    })).toEqual({ status: 'legacy', intent: newerLegacy });

    // A null canonical carrier is PRESENT corrupted state. It must fail closed
    // instead of silently deferring to the legacy override, because two
    // answers for one stored payload apply different models.
    expect(readSessionModelSelectionIntentSourceV1({
      canonical: null,
      legacy: newerLegacy,
    })).toEqual({ status: 'invalid' });
    expect(readSessionModelSelectionIntentSourceV1({
      canonical: null,
      legacy: undefined,
    })).toEqual({ status: 'invalid' });
    expect(resolveSessionModelSelectionIntentV1({
      canonical: null,
      legacy: newerLegacy,
      agentTargetKey: 'agent:codex',
    })).toBeNull();
    expect(sessionModelSelectionIntentRequiresAgentTargetV1({
      canonical: null,
      legacy: newerLegacy,
    })).toBe(false);
  });

  it('projects native and clear intent for released readers but omits provider-bound intent', () => {
    const readReleasedLegacyOverride = (value: Readonly<{ modelId: string }>): string | null => {
      const modelId = value.modelId.trim();
      return modelId && modelId !== 'default' ? modelId : null;
    };
    const nativeProjection = projectSessionModelSelectionIntentToLegacyModelOverrideV1({
      v: 1,
      updatedAt: 20,
      selection: {
        agentTargetKey: 'agent:codex',
        providerConnectionId: null,
        modelId: 'native/model',
      },
    });
    expect(nativeProjection).toEqual({ v: 1, updatedAt: 20, modelId: 'native/model' });
    expect(readReleasedLegacyOverride(nativeProjection)).toBe('native/model');

    const clearProjection = projectSessionModelSelectionIntentToLegacyModelOverrideV1({
      v: 1,
      updatedAt: 21,
      selection: null,
    });
    expect(clearProjection).toEqual({ v: 1, updatedAt: 21, modelId: 'default' });
    expect(readReleasedLegacyOverride(clearProjection)).toBeNull();

    const providerProjection = projectSessionModelSelectionIntentToLegacyModelOverrideV1({
      v: 1,
      updatedAt: 22,
      selection: {
        agentTargetKey: 'agent:codex',
        providerConnectionId: 'pc_work',
        modelId: 'provider/model',
      },
    });
    expect(providerProjection).toBeUndefined();
  });

  it('carries a complete per-message selection while projecting only safe native models to old readers', () => {
    const nativeSelection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 23,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'native/model',
      },
    });
    const providerSelection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 24,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    });

    expect(projectSessionMessageModelSelectionToLegacyModelV1(nativeSelection)).toBe('native/model');
    expect(projectSessionMessageModelSelectionToLegacyModelV1(providerSelection)).toBeUndefined();
    expect(projectSessionMessageModelSelectionToLegacyModelV1({
      ...nativeSelection,
      ref: { ...nativeSelection.ref, modelId: 'default' },
    })).toBeUndefined();

    const meta = withSessionMessageModelSelectionV1({ source: 'ui' }, providerSelection);
    expect(meta).toEqual({ source: 'ui', modelSelectionV1: providerSelection });
    expect(readSessionMessageModelSelectionV1(meta)).toEqual({
      status: 'valid',
      selection: providerSelection,
    });
    expect(readSessionMessageModelSelectionV1({ source: 'ui' })).toEqual({ status: 'absent' });
    expect(readSessionMessageModelSelectionV1({
      modelSelectionV1: { ...providerSelection, ref: { ...providerSelection.ref, modelId: 'invalid model' } },
    })).toEqual({ status: 'invalid' });
    const nativeDefaultSelection = {
      ...nativeSelection,
      ref: { ...nativeSelection.ref, modelId: 'default' },
    };
    expect(readSessionMessageModelSelectionV1({
      modelSelectionV1: nativeDefaultSelection,
    })).toEqual({ status: 'invalid' });
    expect(() => withSessionMessageModelSelectionV1({}, nativeDefaultSelection)).toThrow();
  });

  it.each(['native', 'account_provider_connection', 'team_resource'] as const)(
    'retains the canonical %s per-message source and projects only native legacy model text', source => {
      const selection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 25, ref: {
        source, agentTargetKey: 'backend:codex', modelId: 'selected-model',
        ...(source === 'account_provider_connection' ? { providerConnectionId: 'pc_work' } : {}),
        ...(source === 'team_resource' ? { teamId: 'team', resourceId: 'resource', expectedResourceRevision: 3, deliveryMode: 'direct' } : {}),
      } });
      const meta = withSessionMessageModelSelectionV1({ source: 'ui', model: 'stale-native' }, selection);
      expect(readSessionMessageModelSelectionV1(meta)).toEqual({ status: 'valid', selection });
      expect(meta.modelSelectionV1).toEqual(selection);
      expect(meta.model).toBe(source === 'native' ? 'selected-model' : undefined);
      expect(projectSessionMessageModelSelectionToLegacyModelV1(selection)).toBe(source === 'native' ? 'selected-model' : undefined);
      expect(readSessionMessageModelSelectionV1({ ...meta, model: 'fallback', modelSelectionV1: {
        ...selection, ref: { ...selection.ref, source: 'unknown' },
      } })).toEqual({ status: 'invalid' });
    },
  );

  it('rejects native V2 default resets while retaining a Team model literally named default', () => {
    const native = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 25,
      ref: { source: 'native', agentTargetKey: 'backend:codex', modelId: 'default' } });
    expect(() => withSessionMessageModelSelectionV1({}, native)).toThrow();
    const team = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 25, ref: {
      source: 'team_resource', agentTargetKey: 'backend:codex', modelId: 'default',
      teamId: 'team', resourceId: 'resource', expectedResourceRevision: 3, deliveryMode: 'direct',
    } });
    expect(readSessionMessageModelSelectionV1(withSessionMessageModelSelectionV1({ model: 'default' }, team)))
      .toEqual({ status: 'valid', selection: team });
  });

  it('round-trips provider identity and a literal provider model named default through child argv', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    });

    const encoded = serializeSessionModelSelectionV1(selection);

    expect(encoded).toMatch(/^sms1:[A-Za-z0-9_-]+$/u);
    expect(deserializeSessionModelSelectionV1(encoded)).toEqual(selection);
  });

  it('rejects malformed and non-canonical child argv payloads', () => {
    expect(() => deserializeSessionModelSelectionV1('not-a-selection')).toThrow(/model selection/i);
    expect(() => deserializeSessionModelSelectionV1('sms1:eyJ2IjoyfQ')).toThrow();
  });
});

describe('readAgentDefaultModelSelectionV1', () => {
  it.each([false, true])('reads an external Agent default by contribution identity when saved=%s', saved => {
    const target = { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } } as const;
    const key = 'agent:acme.project-launch/agent';
    const selection = { v: 1, ref: { agentTargetKey: key, providerConnectionId: null, modelId: 'native-model' }, updatedAt: 1 };
    const defaults = saved ? { [key]: selection } : undefined;
    expect(readAgentDefaultModelSelectionV1(defaults, target)).toEqual(saved ? selection : null);
    expect(readAgentDefaultModelSelectionV1(defaults, key)).toEqual(saved ? selection : null);
  });
  it.each(['agent:codex', { kind: 'builtInAgent', agentId: 'codex' }] as const)(
    'preserves a saved bundled Agent default for historical routing input %j', target => {
      const key = 'agent:happier.agent.codex/codex';
      const selection = { v: 1, ref: { agentTargetKey: key, providerConnectionId: null, modelId: 'native-model' }, updatedAt: 1 };
      expect(readAgentDefaultModelSelectionV1({ [key]: selection }, target)).toEqual(selection);
    });
  it('reads the Account default model for an Agent target by its canonical key, and nothing for others', async () => {
    const { readAgentDefaultModelSelectionV1 } = await import('./v1.js');
    const key = 'agent:happier.agent.codex/codex';
    const selection = { v: 1, updatedAt: 3, ref: { agentTargetKey: key, providerConnectionId: null, modelId: 'gpt-5.5' } };
    const defaults = { [key]: selection };
    expect(readAgentDefaultModelSelectionV1(defaults, { kind: 'backend', backendId: 'codex' })).toEqual(selection);
    expect(readAgentDefaultModelSelectionV1(defaults, { kind: 'backend', backendId: 'claude' })).toBeNull();
    expect(readAgentDefaultModelSelectionV1(undefined, { kind: 'backend', backendId: 'codex' })).toBeNull();
  });
});
