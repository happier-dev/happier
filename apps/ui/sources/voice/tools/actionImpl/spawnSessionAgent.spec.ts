import { describe, expect, it } from 'vitest';

import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import { resolveSpawnBackendTargetFromState, resolveVoiceToolSpawnBackendTarget } from './spawnSessionAgent';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';

describe('resolveVoiceToolSpawnBackendTarget (RU-02 customAcp ingress-only)', () => {
  it('uses destination row facts for the automatic configured spawn target', () => {
    resetAcpCatalogSnapshotsForTests();
    const scope = { serverId: 'voice-tool-home', accountId: 'voice-tool-account' };
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      command: 'review', createdAt: 1, updatedAt: 1 });
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 3, record: { v: 1, definitions: [definition] } }, true);
    expect(resolveSpawnBackendTargetFromState({ settingsScope: scope, settings: {
      lastUsedAgent: 'codex', lastUsedBackendTarget: { kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review' },
    } })).toEqual({ kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review', sourceKind: 'configured' });
    resetAcpCatalogSnapshotsForTests();
  });

  it('keeps a built-in automatic spawn independent of configured ACP row availability', () => {
    resetAcpCatalogSnapshotsForTests();
    expect(resolveVoiceToolSpawnBackendTarget({ state: { settingsScope: {
      serverId: 'voice-tool-home', accountId: 'voice-tool-account',
    }, settings: { lastUsedAgent: 'codex' } } })).toEqual({
      ok: true, backendTarget: { kind: 'backend', backendId: 'codex' },
    });
  });

  it('rejects legacy customAcp agentId when backendTargetKey is omitted', () => {
    expect(resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'customAcp',
    })).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
      agentId: 'customAcp',
    });
  });

  it('accepts matching legacy configured ACP flavor carrier for configured backendTargetKey, returning the canonical backend target', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured',
    });

    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'acp:kiro',
      backendTargetKey,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'kiro',
      configuredBackendId: 'kiro',
      sourceKind: 'configured',
    });
  });

  it('rejects legacy customAcp carrier for non-configured backend target keys', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'kiro',
      sourceKind: 'built_in',
    });

    expect(resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'customAcp',
      backendTargetKey,
    })).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
      agentId: 'customAcp',
      backendTargetKey,
    });
  });
  it('accepts an externally installed Agent id and targets it directly', () => {
    // An installed non-bundled Agent is a legitimate voice spawn target: `isBundledAgentId`
    // answers only "is this one of the bundled ids" and must never reject an installed Agent.
    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'acme-agent',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backendTarget).toEqual({ kind: 'backend', backendId: 'acme-agent' });
  });

  it('accepts an externally installed Agent id that matches its backendTargetKey', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'acme-agent',
    });

    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'acme-agent',
      backendTargetKey,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backendTarget.backendId).toBe('acme-agent');
  });

  it('accepts the canonical qualified target key of an installed external Agent named by the current projection', () => {
    // `agent:<pluginId>/<localId>` is the key the Agent catalog, settings and
    // review-engine list all publish for an installed Agent. Voice must resolve
    // it through the same host catalog instead of failing closed on an identity
    // the Protocol reader alone cannot route.
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'agent',
      identity: { pluginId: 'acme.agent', localId: 'native' },
    });

    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      backendTargetKey,
      daemonMergedProjectionInputs: {
        mergedProviderProjectionById: {
          'acme.native': {
            agentId: 'acme.native',
            identity: { pluginId: 'acme.agent', localId: 'native' },
          },
        },
        mergedBackendProjectionById: {},
      } as never,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backendTarget).toEqual({ kind: 'backend', backendId: 'acme.native' });
  });

  it('accepts a qualified external target key together with the Agent local id it addresses', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'agent',
      identity: { pluginId: 'acme.agent', localId: 'native' },
    });

    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'native',
      backendTargetKey,
      daemonMergedProjectionInputs: {
        mergedProviderProjectionById: {
          'acme.native': {
            agentId: 'acme.native',
            identity: { pluginId: 'acme.agent', localId: 'native' },
          },
        },
        mergedBackendProjectionById: {},
      } as never,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backendTarget).toEqual({ kind: 'backend', backendId: 'acme.native' });
  });

  it('rejects a qualified external target key when the requested Agent id addresses another Agent', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'agent',
      identity: { pluginId: 'acme.agent', localId: 'native' },
    });

    expect(resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'other',
      backendTargetKey,
      daemonMergedProjectionInputs: {
        mergedProviderProjectionById: {
          'acme.native': {
            agentId: 'acme.native',
            identity: { pluginId: 'acme.agent', localId: 'native' },
          },
        },
        mergedBackendProjectionById: {},
      } as never,
    })).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      agentId: 'other',
      backendTargetKey,
    });
  });

  it('keeps the qualified identity losslessly when no current projection names its routing id', () => {
    // `backend:<pluginId>/<localId>` is the same Agent as the `agent:` key: the
    // canonical key owner maps it straight back to the identity. Preserve it
    // instead of dropping a legitimate target while the projection is unloaded.
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'agent',
      identity: { pluginId: 'acme.agent', localId: 'native' },
    });

    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      backendTargetKey,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backendTarget).toEqual({ kind: 'backend', backendId: 'acme.agent/native' });
  });
});
