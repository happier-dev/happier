import { describe, expect, it } from 'vitest';

import {
  buildStarterCreateInput,
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
});
