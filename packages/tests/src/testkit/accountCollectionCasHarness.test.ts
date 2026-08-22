import { describe, expect, it } from 'vitest';

import {
  createAccountCollectionCasHarness,
  type AccountCollectionCasBoundary,
  type AccountCollectionSnapshot,
} from './accountCollectionCasHarness';

type Row = Readonly<{ value: string }>;

function createBoundary(): AccountCollectionCasBoundary<Row, string> {
  let snapshot: AccountCollectionSnapshot<Row> = { row: null, revision: null };
  return {
    async read() {
      return snapshot;
    },
    async compareAndSwap(_key, expectedRevision, row) {
      if (expectedRevision !== snapshot.revision) {
        return { kind: 'stale', current: snapshot };
      }
      const revision = snapshot.revision === null ? '1' : String(Number(snapshot.revision) + 1);
      snapshot = { row, revision };
      return { kind: 'written', row, revision };
    },
  };
}

describe('Account Collection CAS crash harness', () => {
  it('exposes the crash window before CAS without pretending the write happened', async () => {
    const boundary = createBoundary();
    const harness = createAccountCollectionCasHarness(boundary);

    await expect(harness.attempt('row-1', { value: 'v1' }, { crashAt: 'afterReadBeforeCas' }))
      .resolves.toMatchObject({ kind: 'crashed', crashPoint: 'afterReadBeforeCas' });
    await expect(boundary.read('row-1')).resolves.toEqual({ row: null, revision: null });
  });

  it('retains the CAS result when observation is lost after a committed write', async () => {
    const boundary = createBoundary();
    const harness = createAccountCollectionCasHarness(boundary);

    const attempt = await harness.attempt('row-1', { value: 'v1' }, { crashAt: 'afterCasBeforeObservation' });
    expect(attempt).toMatchObject({
      kind: 'crashed',
      crashPoint: 'afterCasBeforeObservation',
      casResult: { kind: 'written', revision: '1' },
    });
    await expect(boundary.read('row-1')).resolves.toEqual({ row: { value: 'v1' }, revision: '1' });
  });

  it('leaves stale-writer adjudication to the canonical boundary', async () => {
    const boundary = createBoundary();
    const harness = createAccountCollectionCasHarness(boundary);

    await harness.attempt('row-1', { value: 'v1' });
    const staleBoundary: AccountCollectionCasBoundary<Row, string> = {
      ...boundary,
      async read() {
        return { row: { value: 'v1' }, revision: '1' };
      },
      async compareAndSwap(_key, expectedRevision, row) {
        if (expectedRevision !== '2') {
          return { kind: 'stale', current: { row: { value: 'other-writer' }, revision: '2' } };
        }
        return { kind: 'written', row, revision: '3' };
      },
    };

    const staleAttempt = await createAccountCollectionCasHarness(staleBoundary)
      .attempt('row-1', { value: 'v2' });
    expect(staleAttempt).toMatchObject({
      kind: 'completed',
      casResult: { kind: 'stale', current: { revision: '2' } },
    });
  });
});
