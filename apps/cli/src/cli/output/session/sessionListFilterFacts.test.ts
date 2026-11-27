import { describe, expect, it } from 'vitest';
import { matchSessionListFilterV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectCliSessionListFilterFactsV1 } from './sessionListFilterFacts';

const credentials = { token: 'bob-token', encryption: null };
const workspaceRef = { id: 'checkout', serverId: 'home', machineId: 'alice-machine', rootPath: '/work/project',
  projectKey: 'current-project', createdAtMs: 1 };
const row = createSessionRecordFixture({ id: 'source', encryptionMode: 'plain', ownerAccountId: 'bob', origin: { kind: 'none' },
  metadata: JSON.stringify({ workspaceId: 'checkout', machineId: 'alice-machine', path: '/work/project' }),
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
    capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
const projectFilter = normalizeSessionListFilterV1({ homeServerIds: ['home'],
  projects: { include: [{ serverId: 'home', projectKey: 'current-project' }], exclude: [] } });
const tagFilter = normalizeSessionListFilterV1({ homeServerIds: ['home'], tagIds: { include: [{ serverId: 'home', tagId: 'bob-tag' }], exclude: [] } });

describe('current CLI Session filter facts', () => {
  it('projects authorized Machine, Agent, Owner and Updated facts without supplemental reads', () => {
    const facts = projectCliSessionListFilterFactsV1({ credentials,
      accountEncryption: createAccountEncryptionCurrentnessFixture(), row: { ...row, updatedAt: 123,
        metadata: JSON.stringify({ machineId: 'alice-machine', flavor: 'codex' }) },
      nowMs: 200, serverId: 'home', viewerAccountId: 'bob' });
    const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
      machines: { include: [{ serverId: 'home', machineId: 'alice-machine' }], exclude: [] },
      agents: { include: ['agent:happier.agent.codex/codex'], exclude: [] },
      owners: { include: [{ serverId: 'home', accountId: 'bob' }], exclude: [] }, updated: { op: 'after', atMs: 100 } });
    expect(matchSessionListFilterV1(filter, facts, 'daemonRule')).toBe('match');
    expect(matchSessionListFilterV1({ ...filter, machines: { include: [{ serverId: 'another-home', machineId: 'alice-machine' }], exclude: [] } }, facts, 'daemonRule')).toBe('miss');
    const locked = projectCliSessionListFilterFactsV1({ credentials,
      accountEncryption: createAccountEncryptionCurrentnessFixture(), row: { ...row, metadata: 'locked' },
      nowMs: 200, serverId: 'home', viewerAccountId: 'bob' });
    expect(locked.machine).toBeUndefined();
    expect(locked.agent).toBeUndefined();
    expect(matchSessionListFilterV1(normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
      machines: { include: [], exclude: [{ serverId: 'home', machineId: 'alice-machine' }] } }), locked, 'daemonRule')).toBe('unavailable');
  });
  it.each([undefined, ''])('treats readable pathless metadata as a Project miss (path=%s)', path => {
    const facts = projectCliSessionListFilterFactsV1({ credentials,
      accountEncryption: createAccountEncryptionCurrentnessFixture(),
      row: { ...row, metadata: JSON.stringify({ machineId: 'alice-machine', ...(path === undefined ? {} : { path }) }) },
      nowMs: Date.now(), serverId: 'home', viewerAccountId: 'bob', workspaceRefs: [workspaceRef] });
    expect(matchSessionListFilterV1(projectFilter, facts)).toBe('miss');
    expect(matchSessionListFilterV1(normalizeSessionListFilterV1({ ...projectFilter,
      projects: { include: [], exclude: projectFilter.projects!.include } }), facts)).toBe('match');
  });

  it('keeps unreadable owner facts unavailable rather than treating them as pathless', () => {
    const facts = projectCliSessionListFilterFactsV1({ credentials,
      accountEncryption: createAccountEncryptionCurrentnessFixture(), row: { ...row, metadata: 'unreadable' },
      nowMs: Date.now(), serverId: 'home', viewerAccountId: 'bob', workspaceRefs: [workspaceRef] });
    expect(matchSessionListFilterV1(projectFilter, facts)).toBe('unavailable');
  });

  it('uses prepared current Project and tag assignments in the shared list/preview/evaluator projector', () => {
    const input = { credentials, accountEncryption: createAccountEncryptionCurrentnessFixture(), row,
      nowMs: Date.now(), serverId: 'home', viewerAccountId: 'bob',
      preparedFacts: { workspaceRefs: [workspaceRef], tagIds: ['bob-tag'] } };
    const facts = projectCliSessionListFilterFactsV1(input);
    expect(matchSessionListFilterV1(projectFilter, facts)).toBe('match');
    expect(matchSessionListFilterV1(tagFilter, facts)).toBe('match');
    expect(facts.tagIds).toEqual(['bob-tag']);
  });
});
