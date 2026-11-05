import { describe, expect, it } from 'vitest';

import { SessionOwnerMetadataV1Schema, SessionSharedMetadataV1Schema } from './sessionMetadataSchemasV1.js';
import {
  projectSessionDisplayV1,
  SessionDisplayProjectionV1Schema,
  SessionSharedDisplayV1Schema,
  validateSessionDisplayProjectionV1,
} from './sessionDisplayProjectionV1.js';

describe('Session semantic display', () => {
  it.each([
    ['voice_conversation', true, 'voice_custody'],
    ['voice_carrier', true, 'voice_custody'],
    ['voice_conversation_retired', true, 'voice_custody'],
    ['other-hidden-service', true, undefined],
    ['voice_conversation', false, undefined],
  ])('projects exact Voice custody for key %s hidden %s', (key, hidden, kind) => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
      system: { systemSessionV1: { v: 1, key, hidden } } });
    const display = projectSessionDisplayV1({ sharedMetadata: { v: 1 }, ownerMetadata });
    expect(display.owner).toHaveProperty('hiddenSystemSession', hidden);
    expect(Reflect.get(display.owner!, 'systemSessionKind')).toBe(kind);
    expect(display.shared).not.toHaveProperty('systemSessionKind');
    expect(display.owner).not.toHaveProperty('systemSessionV1');
  });

  it('projects the same admitted tuple into disjoint shared and compact owner facts', () => {
    const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1,
      summary: { text: 'Shared title', updatedAt: 1 }, agentPresentation: { agentId: 'codex' }, bot: { kind: 'bot' },
      publicAgentState: { completedRequests: { privateRequest: { tool: 'Bash', createdAt: 1, completedAt: 2, status: 'approved' } } },
    });
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
      workspace: { name: 'Private title', path: '/private/repo', host: 'private-host', machineId: 'machine',
        homeDir: '/private', projectId: 'project', workspaceId: 'workspace', branch: 'feature' },
      runtime: { lifecycleState: 'stopped', tools: ['private tool'],
        terminal: { mode: 'tmux', tmux: { target: 'private-target' },
          controlServiceabilityV1: { v: 1, state: 'recoverable_unservable', observedAt: 10, reason: 'stopped' } },
        sessionUsageLimitRecoveryV1: { v: 1, status: 'waiting', issueFingerprint: 'issue', armedAtMs: 2,
          resetAtMs: 20, nextCheckAtMs: 20, attemptCount: 1, maxAttempts: 3, lastProbeError: null,
          selectedAuth: { kind: 'profile', serviceId: 'anthropic', profileId: 'private-profile' } } },
      work: { statusReason: 'Preparing release', sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: 2,
        primaryItemId: 'task', items: [
          { id: 'goal', kind: 'goal', origin: 'happier', title: 'Goal', status: 'active', updatedAt: 2 },
          { id: 'task', kind: 'task', origin: 'vendor', title: 'Current task', status: 'blocked', statusReason: 'blocked',
            summary: 'Private detail', updatedAt: 2, providerData: { private: true } },
          { id: 'history', kind: 'task', origin: 'vendor', title: 'Private completed history', status: 'complete', updatedAt: 1 },
        ] } },
      history: { replaySeedV1: { v: 1, seedText: 'Private replay seed', sourceSessionId: 'source', sourceCutoffSeqInclusive: 1, createdAtMs: 1 } },
      system: { systemSessionV1: { v: 1, key: 'private-key', hidden: true } },
    });
    const projected = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
    expect(projected.shared).toEqual({ v: 1, summaryText: 'Shared title', agentPresentation: { agentId: 'codex' }, bot: { kind: 'bot' } });
    expect(projected.owner).toEqual({ v: 1, name: 'Private title', path: '/private/repo', host: 'private-host', machineId: 'machine',
      homeDir: '/private', projectId: 'project', workspaceId: 'workspace', branch: 'feature', lifecycleState: 'stopped',
      terminalControlServiceabilityV1: { v: 1, state: 'recoverable_unservable', observedAt: 10, reason: 'stopped' },
      sessionUsageLimitRecoveryV1: { v: 1, status: 'waiting', issueFingerprint: 'issue', armedAtMs: 2, resetAtMs: 20,
        nextCheckAtMs: 20, attemptCount: 1, maxAttempts: 3, lastProbeError: null, authSelectionKind: 'profile' },
      workDisplay: { v: 1, primaryItem: { id: 'task', kind: 'task', title: 'Current task', status: 'blocked', statusReason: 'blocked' }, hasActiveGoal: true },
      work: { statusReason: 'Preparing release' }, hiddenSystemSession: true,
    });
    const wire = JSON.stringify(projected);
    for (const privateDetail of ['privateRequest', 'private-profile', 'Private detail', 'Private completed history', 'Private replay seed', 'private-target', 'private tool', 'private-key']) {
      expect(wire).not.toContain(privateDetail);
    }
    expect(projectSessionDisplayV1({ sharedMetadata })).toEqual({ shared: projected.shared });
    expect(SessionSharedDisplayV1Schema.safeParse({ ...projected.shared, path: '/private' }).success).toBe(false);
    const mixedShared = { ...sharedMetadata, path: '/private' };
    expect(() => projectSessionDisplayV1({ sharedMetadata: mixedShared })).toThrow();
  });

  it('validates independent content modes and current outer linkage without changing leaf payloads', () => {
    const shared = { t: 'plain', v: { v: 1, audience: 'shared', purpose: 'session_shared_display', display: { v: 1, summaryText: 'Shared title' } } };
    const owner = { t: 'plain', v: { v: 1, audience: 'owner', purpose: 'session_owner_display', display: { v: 1, name: 'Private title' } } };
    const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 2, metadataLayoutVersion: 1, shared, owner });
    const context = { sessionMode: 'plain' as const, accountMode: 'plain' as const, metadataVersion: 2, metadataLayoutVersion: 1 };
    expect(validateSessionDisplayProjectionV1({ ...context, projection })).toEqual({ ok: true, projection });
    expect(validateSessionDisplayProjectionV1({ ...context, accountMode: 'e2ee', projection })).toEqual({ ok: false, reason: 'account_mode_mismatch' });
    expect(validateSessionDisplayProjectionV1({ ...context, sessionMode: 'e2ee', projection })).toEqual({ ok: false, reason: 'session_mode_mismatch' });
    expect(SessionDisplayProjectionV1Schema.safeParse({ ...projection, shared: { ...shared, v: { ...shared.v, sessionId: 'unsupported-intermediate' } } }).success).toBe(false);
    expect(SessionDisplayProjectionV1Schema.safeParse({ ...projection, owner: { ...owner, v: { ...owner.v, sessionId: 'unsupported-intermediate' } } }).success).toBe(false);
    expect(validateSessionDisplayProjectionV1({ ...context, metadataVersion: 3, projection })).toEqual({ ok: false, reason: 'stale_source' });
    const next = { ...projection, sourceMetadataVersion: 3 };
    expect(validateSessionDisplayProjectionV1({ ...context, metadataVersion: 3, projection: next })).toEqual({ ok: true, projection: next });
    expect(next.owner).toBe(projection.owner);
  });

  it('retains external identity without copying source configuration or link authority', () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
      workspace: { sessionWorkspaceLocationV1: { v: 1, machineId: 'machine', agentPath: '/agent', machinePath: '/machine', privateExtension: 'private location configuration' } },
      nativeSession: { externalSessionV1: {
        v: 1, agentId: 'opencode', machineId: 'machine', remoteSessionId: 'remote', linkedAtMs: 10,
        source: { kind: 'opencodeServer', contractVersion: 1, baseUrl: 'http://private-host:4096' },
        linkData: { sourcePath: '/private/transcript.jsonl' },
        followPolicyV1: { v: 1, policy: 'background_follow' },
      } },
    });
    const { owner } = projectSessionDisplayV1({ sharedMetadata: { v: 1 }, ownerMetadata });
    expect(owner?.externalSessionV1).toMatchObject({ v: 1, agentId: 'opencode', machineId: 'machine', remoteSessionId: 'remote', linkedAtMs: 10 });
    expect(owner?.externalSessionV1?.source).toEqual({ kind: 'opencodeServer' });
    expect(owner?.sessionWorkspaceLocationV1).toEqual({ v: 1, machineId: 'machine', agentPath: '/agent', machinePath: '/machine' });
    expect(JSON.stringify(owner)).not.toContain('private-host');
    expect(JSON.stringify(owner)).not.toContain('private location configuration');
    expect(owner?.externalSessionV1).not.toHaveProperty('linkData');
    expect(owner?.externalSessionV1).not.toHaveProperty('followPolicyV1');
  });
});
