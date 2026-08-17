import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';
import {
  buildLinkedExternalSessionMetadataV1,
  deriveExternalSessionAttentionHasUnread,
  markExternalSessionAttentionUnreadV1,
  normalizeLinkedExternalSessionMetadataV1,
  readExternalHistoryImportV1FromMetadata,
  readLinkedExternalSessionV1FromMetadata,
  resolveExternalHistoryImportV1FromMetadata,
  resolveLinkedExternalSessionMetadataV1,
} from '../index.js';

describe('direct session linked metadata helpers', () => {
  it('reads canonical and released conversion tombstones into the canonical shape', () => {
    const canonical = {
      externalHistoryImportV1: {
        v: 1,
        agentId: 'codex',
        remoteSessionId: 'remote-1',
        importedAtMs: 100,
        source: { kind: 'codexHome', home: 'user' },
        linkData: { projectId: 'project-1' },
      },
    };
    expect(readExternalHistoryImportV1FromMetadata(canonical)).toEqual({
      v: 1,
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'codexHome', home: 'user' },
      linkData: { projectId: 'project-1' },
    });
    expect(readExternalHistoryImportV1FromMetadata(canonical))
      .toEqual(canonical.externalHistoryImportV1);

    expect(readExternalHistoryImportV1FromMetadata({
      externalHistoryImportV1: {
        v: 1,
        providerId: 'codex',
        remoteSessionId: 'remote-released',
        importedAtMs: 101,
        source: { kind: 'codexHome', home: 'user' },
      },
    })).toEqual({
      v: 1,
      agentId: 'codex',
      remoteSessionId: 'remote-released',
      importedAtMs: 101,
      source: { kind: 'codexHome', home: 'user' },
    });
  });

  it.each([
    ['blank released identity', {
      v: 1,
      providerId: '   ',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'codexHome', home: 'user' },
    }],
    ['noncanonical released identity', {
      v: 1,
      providerId: ' codex ',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'codexHome', home: 'user' },
    }],
    ['released shape with an extra field', {
      v: 1,
      providerId: 'codex',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'codexHome', home: 'user' },
      extra: true,
    }],
    ['conflicting released and canonical identities', {
      v: 1,
      providerId: 'claude',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'codexHome', home: 'user' },
    }],
    ['released identity with canonical-only link data', {
      v: 1,
      providerId: 'codex',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'codexHome', home: 'user' },
      linkData: { projectId: 'project-1' },
    }],
    ['oversized remote session id', {
      v: 1,
      agentId: 'codex',
      remoteSessionId: 'x'.repeat(2_001),
      importedAtMs: 100,
      source: { kind: 'codexHome', home: 'user' },
    }],
  ])('fails closed for a %s conversion tombstone', (_label, externalHistoryImportV1) => {
    expect(readExternalHistoryImportV1FromMetadata({
      externalHistoryImportV1,
    })).toBeNull();
  });

  it('distinguishes an absent conversion tombstone from a malformed present tombstone', () => {
    expect(resolveExternalHistoryImportV1FromMetadata({})).toEqual({
      state: 'absent',
    });
    expect(resolveExternalHistoryImportV1FromMetadata({
      externalHistoryImportV1: {
        v: 1,
        providerId: 'codex',
        remoteSessionId: 'remote-1',
        importedAtMs: 100,
        source: { kind: 'codexHome', home: 'user' },
        linkData: { projectId: 'canonical-only' },
      },
    })).toEqual({
      state: 'invalid',
      error: 'external_history_import_invalid',
    });
  });

  it('normalizes legacy directSessionV1 metadata to canonical externalSessionV1', () => {
    expect(typeof (protocol as any).readLinkedExternalSessionV1FromMetadata).toBe('function');
    expect(typeof (protocol as any).normalizeLinkedExternalSessionMetadataV1).toBe('function');

    const metadata = {
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        linkedAtMs: 42,
      },
    };

    expect(readLinkedExternalSessionV1FromMetadata(metadata)).toEqual({
      v: 1,
      agentId: 'claude',
      machineId: 'machine-legacy',
      remoteSessionId: 'remote-legacy',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      linkedAtMs: 42,
    });
    expect((protocol as any).normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual({
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        linkedAtMs: 42,
      },
    });
  });

  it('does not trim a released directSessionV1 provider identity', () => {
    const metadata = {
      directSessionV1: {
        v: 1,
        providerId: ' codex ',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'codexHome', home: 'user' },
      },
    };

    expect(readLinkedExternalSessionV1FromMetadata(metadata)).toBeNull();
    expect(normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual(metadata);
  });

  it('reads released Claude source project identity forward into canonical linkData without adapting new writes', () => {
    const releasedLink = {
      v: 1 as const,
      providerId: 'claude',
      machineId: 'machine-released',
      remoteSessionId: 'remote-released',
      source: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        projectId: 'project-released',
      },
      linkedAtMs: 42,
    };
    const metadata = { directSessionV1: releasedLink };

    expect(readLinkedExternalSessionV1FromMetadata(metadata)).toEqual({
      v: 1,
      agentId: 'claude',
      machineId: 'machine-released',
      remoteSessionId: 'remote-released',
      source: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        projectId: 'project-released',
      },
      linkData: { projectId: 'project-released' },
      linkedAtMs: 42,
    });
    expect(normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual({
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-released',
        remoteSessionId: 'remote-released',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude',
          projectId: 'project-released',
        },
        linkData: { projectId: 'project-released' },
        linkedAtMs: 42,
      },
    });

    const qualifiedCurrentLink = {
      v: 1 as const,
      agentId: 'claude',
      machineId: 'machine-current',
      remoteSessionId: 'remote-current',
      source: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        projectId: 'project-current',
      },
      qualifiedIdentity: {
        v: 1 as const,
        agent: { pluginId: 'happier.claude', localId: 'claude' },
        source: { kind: 'claudeConfig', contractVersion: 1 as const },
      },
    };
    expect(readLinkedExternalSessionV1FromMetadata({
      externalSessionV1: qualifiedCurrentLink,
    })).toEqual(qualifiedCurrentLink);
    expect(buildLinkedExternalSessionMetadataV1({}, qualifiedCurrentLink))
      .toMatchObject({ externalSessionV1: qualifiedCurrentLink });
    expect(
      buildLinkedExternalSessionMetadataV1({}, qualifiedCurrentLink).externalSessionV1,
    ).not.toHaveProperty('linkData');

    const {
      providerId: _releasedProviderId,
      ...releasedLinkFields
    } = releasedLink;
    const existingCanonicalLinkData = {
      ...releasedLinkFields,
      agentId: 'claude',
      linkData: { projectId: 'project-canonical' },
    };
    expect(readLinkedExternalSessionV1FromMetadata({
      externalSessionV1: existingCanonicalLinkData,
    })).toMatchObject({
      linkData: { projectId: 'project-canonical' },
    });
  });

  it('requires reconciliation when a canonical row has a malformed rollback projection', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-canonical',
        remoteSessionId: 'remote-canonical',
        source: { kind: 'codexHome', home: 'user' },
      },
      directSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    };

    expect(resolveLinkedExternalSessionMetadataV1(metadata)).toEqual({
      ok: false,
      error: 'linked_session_reconciliation_required',
      reason: 'legacy_invalid',
    });
    expect((protocol as any).readLinkedExternalSessionV1FromMetadata(metadata)).toBeNull();
    expect((protocol as any).normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual(metadata);
  });

  it('reconciles only a provably newer rollback-era follow policy after exact dual-row identity agreement', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 10,
        followPolicyV1: {
          v: 1,
          policy: 'attached_only',
          updatedAtMs: 20,
        },
      },
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 10,
        followPolicyV1: {
          v: 1,
          policy: 'background_follow',
          updatedAtMs: 30,
        },
      },
    };

    expect(resolveLinkedExternalSessionMetadataV1(metadata)).toEqual({
      ok: true,
      source: 'reconciled_legacy_follow_policy',
      linkedSession: {
        ...metadata.externalSessionV1,
        followPolicyV1: metadata.directSessionV1.followPolicyV1,
      },
    });
    expect(readLinkedExternalSessionV1FromMetadata(metadata)).toMatchObject({
      followPolicyV1: {
        policy: 'background_follow',
        updatedAtMs: 30,
      },
    });
    expect(normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual({
      externalSessionV1: {
        ...metadata.externalSessionV1,
        followPolicyV1: metadata.directSessionV1.followPolicyV1,
      },
    });
  });

  it('requires typed reconciliation instead of silently choosing a divergent source, runtime, or unversioned policy', () => {
    const canonical = {
      v: 1 as const,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome' as const, home: 'user' as const },
      linkedAtMs: 10,
      runtimeDescriptorV1: {
        v: 1 as const,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      },
      followPolicyV1: {
        v: 1 as const,
        policy: 'attached_only' as const,
      },
    };
    const legacy = {
      v: 1 as const,
      providerId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome' as const, home: 'user' as const },
      linkedAtMs: 10,
      agentRuntimeDescriptorV1: {
        v: 1 as const,
        providerId: 'codex',
        provider: { backendMode: 'appServer' },
      },
      followPolicyV1: {
        v: 1 as const,
        policy: 'background_follow' as const,
      },
    };

    expect(resolveLinkedExternalSessionMetadataV1({
      externalSessionV1: canonical,
      directSessionV1: {
        ...legacy,
        source: { kind: 'codexHome', home: 'custom' },
      },
    })).toEqual({
      ok: false,
      error: 'linked_session_reconciliation_required',
      reason: 'source_conflict',
    });
    expect(resolveLinkedExternalSessionMetadataV1({
      externalSessionV1: canonical,
      directSessionV1: {
        ...legacy,
        agentRuntimeDescriptorV1: {
          ...legacy.agentRuntimeDescriptorV1,
          provider: { backendMode: 'exec' },
        },
      },
    })).toEqual({
      ok: false,
      error: 'linked_session_reconciliation_required',
      reason: 'runtime_conflict',
    });
    expect(resolveLinkedExternalSessionMetadataV1({
      externalSessionV1: canonical,
      directSessionV1: legacy,
    })).toEqual({
      ok: false,
      error: 'linked_session_reconciliation_required',
      reason: 'follow_policy_conflict',
    });
    expect(readLinkedExternalSessionV1FromMetadata({
      externalSessionV1: canonical,
      directSessionV1: legacy,
    })).toBeNull();
  });

  it('rejects malformed known follow lifecycle fields at persisted-link admission', () => {
    const base = {
      v: 1 as const,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome' as const, home: 'user' as const },
    };
    const { agentId: _canonicalAgentId, ...releasedBase } = base;

    expect(resolveLinkedExternalSessionMetadataV1({
      externalSessionV1: {
        ...base,
        followStatusV1: {
          v: 1,
          status: 'not-a-status',
          updatedAtMs: 10,
        },
      },
    })).toEqual({
      ok: false,
      error: 'linked_session_invalid',
      reason: 'canonical_invalid',
    });
    expect(resolveLinkedExternalSessionMetadataV1({
      directSessionV1: {
        ...releasedBase,
        providerId: 'codex',
        lastFollowIssueV1: {
          v: 1,
          code: '',
          observedAtMs: 10,
        },
      },
    })).toEqual({
      ok: false,
      error: 'linked_session_invalid',
      reason: 'legacy_invalid',
    });
  });

  it('rejects undeclared current link fields', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'codexHome', home: 'user' },
        futureMutableState: { revision: 1 },
      },
    };

    expect(resolveLinkedExternalSessionMetadataV1(metadata)).toEqual({
      ok: false,
      error: 'linked_session_invalid',
      reason: 'canonical_invalid',
    });
  });

  it('writes one canonical link and removes a legacy rollback representation', () => {
    expect(typeof (protocol as any).buildLinkedExternalSessionMetadataV1).toBe('function');

    expect((protocol as any).buildLinkedExternalSessionMetadataV1({
      path: '/tmp/project',
      directSessionV1: { v: 1, providerId: 'claude' },
    }, {
      v: 1,
      agentId: 'codex',
      machineId: 'machine-canonical',
      remoteSessionId: 'remote-canonical',
      source: { kind: 'codexHome', home: 'user' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          agentExtra: { owner: 'codex', schemaId: 'codex.runtime', v: 1 },
        },
      },
    })).toEqual({
      path: '/tmp/project',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-canonical',
        remoteSessionId: 'remote-canonical',
        source: { kind: 'codexHome', home: 'user' },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            agentExtra: { owner: 'codex', schemaId: 'codex.runtime', v: 1 },
          },
        },
      },
    });
  });

  it('qualifies canonical links without leaking current runtime generation into persistence', () => {
    expect(typeof (protocol as any).buildLinkedExternalSessionQualifiedIdentityV1).toBe('function');

    const qualifiedIdentity = (protocol as any).buildLinkedExternalSessionQualifiedIdentityV1({
      agent: { pluginId: 'com.example.external-agent', localId: 'assistant' },
      sourceKind: 'claudeConfig',
    });

    expect(qualifiedIdentity).toEqual({
      v: 1,
      agent: { pluginId: 'com.example.external-agent', localId: 'assistant' },
      source: { kind: 'claudeConfig', contractVersion: 1 },
    });
    expect(qualifiedIdentity).not.toHaveProperty('generation');

    expect((protocol as any).buildLinkedExternalSessionMetadataV1({}, {
      v: 1,
      agentId: 'claude',
      machineId: 'machine-qualified',
      remoteSessionId: 'remote-qualified',
      source: { kind: 'claudeConfig', configDir: '/tmp/project' },
      qualifiedIdentity,
      linkData: { projectId: 'project-qualified' },
    })).toEqual({
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-qualified',
        remoteSessionId: 'remote-qualified',
        source: { kind: 'claudeConfig', configDir: '/tmp/project' },
        qualifiedIdentity,
        linkData: { projectId: 'project-qualified' },
      },
    });
  });

  it('rejects a qualified identity that disagrees with the link source contract', () => {
    const read = (protocol as any).readLinkedExternalSessionV1FromMetadata;
    const base = {
      v: 1,
      agentId: 'claude',
      machineId: 'machine-qualified',
      remoteSessionId: 'remote-qualified',
      source: { kind: 'claudeConfig', configDir: '/tmp/project' },
      linkData: {},
    };

    expect(read({
      externalSessionV1: {
        ...base,
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'com.example.external-agent', localId: 'assistant' },
          source: { kind: 'codexHome', contractVersion: 1 },
        },
      },
    })).toBeNull();
  });

  it('round-trips unknown future Codex backend modes for leaf-owned validation', () => {
    const externalSessionV1 = {
      v: 1,
      agentId: 'codex',
      machineId: 'machine-canonical',
      remoteSessionId: 'remote-canonical',
      source: { kind: 'codexHome', home: 'user' },
      codexBackendMode: 'future-codex-mode',
    };
    const metadata = { externalSessionV1 };

    expect((protocol as any).readLinkedExternalSessionV1FromMetadata(metadata)).toEqual(externalSessionV1);
    expect((protocol as any).normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual({
      externalSessionV1,
    });
  });

  it('fails closed when canonical and deployed linked-session identities conflict', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        providerId: 'claude',
        machineId: 'machine-conflict',
        remoteSessionId: 'remote-conflict',
        source: { kind: 'codexHome', home: 'user' },
      },
    };

    expect((protocol as any).readLinkedExternalSessionV1FromMetadata(metadata)).toBeNull();
  });

  it('does not treat a released-only providerId shape as canonical current metadata', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine-current',
        remoteSessionId: 'remote-current',
        source: { kind: 'codexHome', home: 'user' },
      },
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-released',
        remoteSessionId: 'remote-released',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    };

    expect(readLinkedExternalSessionV1FromMetadata(metadata)).toBeNull();
    expect(normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual(metadata);
  });

  it('does not preserve an unreleased agentId alias under the legacy metadata key', () => {
    const metadata = {
      directSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-unreleased',
        remoteSessionId: 'remote-unreleased',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    };

    expect(readLinkedExternalSessionV1FromMetadata(metadata)).toBeNull();
    expect(normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual(metadata);
  });

  it('fails closed on malformed canonical metadata instead of falling back to legacy metadata', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: '',
        remoteSessionId: 'remote-canonical',
        source: { kind: 'codexHome', home: 'user' },
      },
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    };

    expect(readLinkedExternalSessionV1FromMetadata(metadata)).toBeNull();
    expect(normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual(metadata);
  });

  it('removes canonical and legacy linked external session metadata', () => {
    expect(typeof (protocol as any).removeLinkedExternalSessionMetadataV1).toBe('function');

    const metadata = {
      path: '/tmp/project',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-canonical',
        remoteSessionId: 'remote-canonical',
        source: { kind: 'codexHome', home: 'user' },
      },
      directSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    };

    expect((protocol as any).removeLinkedExternalSessionMetadataV1(metadata)).toEqual({
      path: '/tmp/project',
    });
  });

  it('rejects undeclared follow policy fields before rebuilding metadata', () => {
    expect(typeof (protocol as any).readExternalSessionFollowPolicyV1).toBe('function');
    expect(typeof (protocol as any).buildExternalSessionFollowPolicyV1).toBe('function');

    expect((protocol as any).readExternalSessionFollowPolicyV1({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
      extra: 'ignored',
    })).toBeNull();

    const parsed = (protocol as any).readExternalSessionFollowPolicyV1({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
    });
    expect(parsed).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
    });
    expect((protocol as any).buildExternalSessionFollowPolicyV1(parsed)).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
    });
  });

  it('derives observed progress and advances attention without clobbering viewed markers', () => {
    expect(typeof (protocol as any).deriveExternalSessionObservedProgress).toBe('function');
    expect(typeof (protocol as any).applyObservedProgressToExternalSessionAttentionV1).toBe('function');
    expect(typeof (protocol as any).buildExternalSessionAttentionV1).toBe('function');

    const progress = (protocol as any).deriveExternalSessionObservedProgress([
      { id: 'msg-2', createdAtMs: 20 },
    ]);

    expect(progress).toEqual({
      token: '20:msg-2',
      atMs: 20,
    });

    const nextAttention = (protocol as any).applyObservedProgressToExternalSessionAttentionV1({
      observedProgressToken: '10:msg-1',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 10,
      viewedAtMs: 10,
    }, progress);

    expect(nextAttention).toEqual({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 20,
      viewedAtMs: 10,
    });
    expect((protocol as any).buildExternalSessionAttentionV1(nextAttention)).toEqual({
      v: 1,
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 20,
      viewedAtMs: 10,
    });
  });

  it('derives same-timestamp observed progress deterministically regardless of batch order', () => {
    const derive = (protocol as any).deriveExternalSessionObservedProgress;

    const first = derive([
      { id: 'msg-b', createdAtMs: 20 },
      { id: 'msg-a', createdAtMs: 20 },
    ]);
    const second = derive([
      { id: 'msg-a', createdAtMs: 20 },
      { id: 'msg-b', createdAtMs: 20 },
    ]);

    expect(first).toEqual({
      token: '20:msg-b',
      atMs: 20,
    });
    expect(second).toEqual(first);
  });

  it('does not regress observed progress when a same-timestamp batch arrives out of order', () => {
    const apply = (protocol as any).applyObservedProgressToExternalSessionAttentionV1;

    const current = {
      observedProgressToken: '20:msg-b',
      viewedProgressToken: '20:msg-a',
      observedAtMs: 20,
      viewedAtMs: 20,
    };

    expect(apply(current, {
      token: '20:msg-a',
      atMs: 20,
    })).toEqual(current);

    expect(apply(current, {
      token: '20:msg-c',
      atMs: 20,
    })).toEqual({
      observedProgressToken: '20:msg-c',
      viewedProgressToken: '20:msg-a',
      observedAtMs: 20,
      viewedAtMs: 20,
    });
  });

  it('marks attention viewed and derives unread from the normalized snapshot', () => {
    expect(typeof (protocol as any).readExternalSessionAttentionV1).toBe('function');
    expect(typeof (protocol as any).markExternalSessionAttentionViewedV1).toBe('function');
    expect(typeof (protocol as any).deriveExternalSessionAttentionHasUnread).toBe('function');

    const attention = (protocol as any).readExternalSessionAttentionV1({
      v: 1,
      observedProgressToken: '20:msg-2',
      observedAtMs: 20,
    });

    expect((protocol as any).deriveExternalSessionAttentionHasUnread(attention)).toBe(true);

    const viewed = (protocol as any).markExternalSessionAttentionViewedV1(attention);
    expect(viewed).toEqual({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '20:msg-2',
      observedAtMs: 20,
      viewedAtMs: 20,
    });
    expect((protocol as any).deriveExternalSessionAttentionHasUnread(viewed)).toBe(false);
  });

  it('marks viewed direct-session attention unread by clearing viewed progress only', () => {
    const unread = markExternalSessionAttentionUnreadV1({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '20:msg-2',
      observedAtMs: 20,
      viewedAtMs: 20,
    });

    expect(unread).toEqual({
      observedProgressToken: '20:msg-2',
      observedAtMs: 20,
    });
    expect(deriveExternalSessionAttentionHasUnread(unread)).toBe(true);
  });

  it('does not invent unread direct-session attention without observed progress', () => {
    expect(markExternalSessionAttentionUnreadV1(null)).toBeNull();
    expect(markExternalSessionAttentionUnreadV1({
      viewedProgressToken: '20:msg-2',
      viewedAtMs: 20,
    })).toEqual({
      viewedProgressToken: '20:msg-2',
      viewedAtMs: 20,
    });
  });
});
