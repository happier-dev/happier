import { describe, expect, it } from 'vitest';

import { decodeAzureScanContinuation, encodeAzureScanContinuation } from './continuation.js';
import { createAzureScanFrontier, recordAzureWalkHealth } from './paging.js';
import type { AzureScanFrontier } from './types.js';

function frontier(overrides: Partial<AzureScanFrontier> = {}): AzureScanFrontier {
  return Object.assign(
    createAzureScanFrontier({ scanLimit: 64 }),
    overrides,
  );
}

function encoded(source: AzureScanFrontier): string {
  const continuation = encodeAzureScanContinuation(source);
  if (continuation === null) throw new Error('the fixture frontier must encode');
  return continuation.token;
}

describe('Azure DevOps scan continuation codec', () => {
  it('round-trips the frontier this source produced, including its rotation position', () => {
    const source = frontier({
      projectId: '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d',
      projectNextToken: 'project-2',
      currentRepositoryId: 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b',
      nextLaneIndex: 1,
      lanes: [
        { laneId: 'authored', skip: 30, ended: false },
        { laneId: 'reviewer', skip: 0, ended: false },
      ],
    });

    const decoded = decodeAzureScanContinuation({ v: 1, token: encoded(source) });

    expect(decoded).not.toBeNull();
    expect(decoded?.nextLaneIndex).toBe(1);
    expect(decoded?.lanes).toEqual(source.lanes);
    // The budget belongs to the page being built, never to the resumed token.
    expect(decoded?.observed).toBe(0);
  });

  it('carries the sticky walk health forward so a later page still knows what the walk lost', () => {
    // `sources/SCM.md` §2.8b: a reason naming something the walk could not inspect, or that
    // moved under it, is observed on one call and asserted on another. A frontier that drops it
    // makes the honest arm unreachable — the settling call reports a clean walk it never saw.
    const source = frontier();
    recordAzureWalkHealth(source, 'offset-paging');
    recordAzureWalkHealth(source, 'repository-enumeration-incomplete');

    const decoded = decodeAzureScanContinuation({ v: 1, token: encoded(source) });

    // The set is held in §2.8b's declaration order, because that order *is* the precedence the
    // evidence arm reports with — not the order the walk happened to observe them in.
    expect(decoded?.walkHealth).toEqual(['repository-enumeration-incomplete', 'offset-paging']);
  });

  it('refuses a continuation carrying an unrecognized sticky health reason', () => {
    // A caveat this version does not recognize is a token this source did not mint at this
    // version. Dropping it silently would turn an unknown truncation into a clean walk.
    const token = encoded(frontier()).replace('"walkHealth":[]', '"walkHealth":["ceiling-2"]');
    expect(token).toContain('ceiling-2');

    expect(decodeAzureScanContinuation({ v: 1, token })).toBeNull();
  });

  it('refuses a rotation position, scan budget, or lane set it could not have produced', () => {
    const base = encoded(frontier());

    expect(decodeAzureScanContinuation({ v: 1, token: base.replace('"nextLaneIndex":0', '"nextLaneIndex":2') }))
      .toBeNull();
    expect(decodeAzureScanContinuation({ v: 1, token: base.replace('"scanLimit":64', '"scanLimit":0') }))
      .toBeNull();
    expect(decodeAzureScanContinuation({ v: 1, token: base.replace('"authored"', '"mentioned"') }))
      .toBeNull();
    expect(decodeAzureScanContinuation({ v: 1, token: '{"v":9}' })).toBeNull();
  });

  it('carries only the invocation frontier', () => {
    const token = encoded(frontier({
      projectNextToken: 'p'.repeat(64),
      currentRepositoryId: 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b',
      lastCompletedRepositoryId: 'a0d31c2e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    }));
    // The frontier is a function of the contract, never of the account's inventory: no
    // repository list, delivered-id history, viewer record, or credential travels in it.
    expect(token).not.toContain('Basic');
  });
});
