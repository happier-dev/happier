import { describe, expect, it } from 'vitest';
import type { ProjectStarterCreateResumeV1 } from '@happier-dev/protocol/projects/starters/createV1';

import {
  buildStarterCreateInput,
  createStarterIntentKeys,
  deriveRepositoryName,
  readStarterCreateOutcome,
} from './newAppDraft';

const draft = {
  starterId: 'static-website',
  description: '  An order page for my bakery.  ',
  name: 'Rye & Co. orders',
  machineId: 'm1',
};
const facts = {
  serverId: 'home',
  homeDir: '/home/alice',
  owner: 'alice',
  requestKey: 'k1',
};

describe('New app draft (projects.starters.create operands)', () => {
  it('derives a repository and folder name people would type themselves', () => {
    expect(deriveRepositoryName('Rye & Co. orders')).toBe('rye-co-orders');
    expect(deriveRepositoryName('  Café   Menü!! ')).toBe('cafe-menu');
    expect(deriveRepositoryName('***')).toBe('');
  });

  it('builds the reviewed operands only once every one of them is known', () => {
    expect(buildStarterCreateInput(draft, facts)).toEqual({
      serverId: 'home',
      machineId: 'm1',
      requestKey: 'k1',
      starterId: 'static-website',
      description: 'An order page for my bakery.',
      destinationParentPath: '/home/alice/src',
      destinationDirectoryName: 'rye-co-orders',
      repository: {
        owner: 'alice',
        name: 'rye-co-orders',
        visibility: 'private',
      },
    });
    expect(
      buildStarterCreateInput({ ...draft, description: '   ' }, facts),
    ).toBeNull();
    expect(
      buildStarterCreateInput({ ...draft, machineId: null }, facts),
    ).toBeNull();
    expect(
      buildStarterCreateInput(draft, { ...facts, owner: null }),
    ).toBeNull();
    expect(buildStarterCreateInput({ ...draft, name: '!!' }, facts)).toBeNull();
  });

  it('reads the Action result into one state with its one next step', () => {
    const created = {
      kind: 'created',
      projectId: 'p',
      sourceId: 's',
      repositoryUrl: 'https://github.com/alice/rye-co-orders',
      starterId: 'static-website',
      commit: 'c',
      workspace: { machineId: 'm1' },
      sessionHandoff: {
        machineId: 'm1',
        directory: '/home/alice/src/rye-co-orders',
        initialMessage: 'An order page.',
      },
    };
    expect(readStarterCreateOutcome(created)).toMatchObject({
      kind: 'created',
      handoff: created.sessionHandoff,
    });
    expect(
      readStarterCreateOutcome({
        kind: 'failed',
        phase: 'admission',
        code: 'scm_account_required',
      }),
    ).toEqual({ kind: 'needsScmAccount' });
    expect(
      readStarterCreateOutcome({
        kind: 'partial',
        phase: 'checkout',
        code: 'machine_unreachable',
        repositoryUrl: 'https://github.com/alice/rye-co-orders',
      }),
    ).toMatchObject({
      kind: 'failed',
      phase: 'checkout',
      repositoryCreated: true,
    });
    expect(
      readStarterCreateOutcome({
        kind: 'failed',
        phase: 'publish',
        code: 'outcome_unknown',
      }),
    ).toMatchObject({ kind: 'outcomeUnknown' });
    expect(readStarterCreateOutcome({ unexpected: true })).toMatchObject({
      kind: 'failed',
      code: 'invalid_result',
    });
  });

  it('keeps one create intent per reviewed draft: a retry reuses it, a changed name mints a new one', () => {
    let n = 0;
    const keyFor = createStarterIntentKeys(() => `k${++n}`);
    const reviewed = { starterId: 's', description: 'd', name: 'rye-orders', machineId: 'm1', owner: 'alice' };
    expect(keyFor(reviewed)).toBe('k1');
    expect(keyFor({ ...reviewed })).toBe('k1');
    expect(keyFor({ ...reviewed, name: 'rye-orders-2' })).toBe('k2');
  });

  it('reads the owner\'s remediation label as the next step', () => {
    expect(readStarterCreateOutcome({ kind: 'failed', phase: 'publish', code: 'remote_conflict',
      remediation: { kind: 'retry', label: 'Choose another name' } }))
      .toMatchObject({ kind: 'failed', remediation: 'Choose another name' });
  });

  it('explains a missing folder with the existing SCM recovery when no remediation was supplied', () => {
    const outcome = readStarterCreateOutcome({ kind: 'failed', phase: 'account', code: 'ROOT_NOT_FOUND' });
    expect(outcome).toMatchObject({ kind: 'failed', code: 'ROOT_NOT_FOUND', phase: 'account',
      remediation: expect.stringMatching(/folder.*choose another folder/i) });
  });
});

it.each([
  { phase: 'source', sourceId: undefined },
  { phase: 'project', sourceId: 'source-already-created' },
])('retains the published checkout continuation after a $phase failure', ({ phase, sourceId }) => {
  const resume = {
    directory: '/home/alice/src/rye-co-orders',
    repositoryUrl: 'https://github.com/alice/rye-co-orders',
    repository: {
      provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'alice/rye-co-orders', cloneUrl: 'https://github.com/alice/rye-co-orders.git' },
      protocol: 'https',
    },
    commit: '6c7a360ddb4a0d75be06044bf8a914f260ff10c7',
    ...(sourceId ? { sourceId } : {}),
  } satisfies ProjectStarterCreateResumeV1;
  const outcome = readStarterCreateOutcome({
    kind: 'partial', phase, code: 'source_backend_unavailable',
    repositoryUrl: resume.repositoryUrl, resume,
  });
  expect(outcome).toMatchObject({ kind: 'failed', phase, repositoryCreated: true, resume });
});

it('keeps acknowledged work visible when a continuation retry loses its transport', () => {
  const resume: ProjectStarterCreateResumeV1 = {
    directory: '/home/alice/src/rye-co-orders', repositoryUrl: 'https://github.com/alice/rye-co-orders',
    repository: {
      provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'alice/rye-co-orders' }, protocol: 'https',
    },
    commit: '6c7a360ddb4a0d75be06044bf8a914f260ff10c7', sourceId: 'source-already-created',
  };
  const partial = readStarterCreateOutcome({ kind: 'partial', phase: 'project', code: 'project_unavailable',
    repositoryUrl: resume.repositoryUrl, resume });
  if (partial.kind !== 'failed') throw new Error('Expected a retryable partial');
  const failedRetry = readStarterCreateOutcome({ kind: 'failed', code: 'transport_lost' }, partial.resume);
  expect(failedRetry).toMatchObject({ kind: 'failed', repositoryCreated: true, resume });
});
