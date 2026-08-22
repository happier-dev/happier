/**
 * Test-only orchestration around the Account Collection persistence boundary.
 *
 * The harness does not implement Collection reads, schema validation, revision
 * allocation, uniqueness, or encryption. A Data-owner adapter supplies those
 * operations; this wrapper makes the two deciding crash windows explicit so a
 * feature test can prove retry/rejoin and stale-writer behavior against the
 * real database boundary.
 */
export type AccountCollectionRevision = string | null;

export type AccountCollectionSnapshot<Row> = Readonly<{
  row: Row | null;
  revision: AccountCollectionRevision;
}>;

export type AccountCollectionCasResult<Row> =
  | Readonly<{ kind: 'written'; row: Row; revision: string }>
  | Readonly<{ kind: 'stale'; current: AccountCollectionSnapshot<Row> }>;

export type AccountCollectionCasBoundary<Row, Key> = Readonly<{
  read(key: Key): Promise<AccountCollectionSnapshot<Row>>;
  compareAndSwap(
    key: Key,
    expectedRevision: AccountCollectionRevision,
    row: Row,
  ): Promise<AccountCollectionCasResult<Row>>;
}>;

export type AccountCollectionCrashPoint = 'afterReadBeforeCas' | 'afterCasBeforeObservation';

export type AccountCollectionCasAttempt<Row> =
  | Readonly<{
      kind: 'crashed';
      crashPoint: AccountCollectionCrashPoint;
      before: AccountCollectionSnapshot<Row>;
      casResult?: AccountCollectionCasResult<Row>;
    }>
  | Readonly<{
      kind: 'completed';
      before: AccountCollectionSnapshot<Row>;
      casResult: AccountCollectionCasResult<Row>;
      after: AccountCollectionSnapshot<Row>;
    }>;

export function createAccountCollectionCasHarness<Row, Key>(
  boundary: AccountCollectionCasBoundary<Row, Key>,
): Readonly<{
  attempt(
    key: Key,
    nextRow: Row,
    options?: Readonly<{ crashAt?: AccountCollectionCrashPoint }>,
  ): Promise<AccountCollectionCasAttempt<Row>>;
}> {
  return {
    async attempt(key, nextRow, options) {
      const before = await boundary.read(key);
      if (options?.crashAt === 'afterReadBeforeCas') {
        return { kind: 'crashed', crashPoint: options.crashAt, before };
      }

      const casResult = await boundary.compareAndSwap(key, before.revision, nextRow);
      if (options?.crashAt === 'afterCasBeforeObservation') {
        return { kind: 'crashed', crashPoint: options.crashAt, before, casResult };
      }

      return {
        kind: 'completed',
        before,
        casResult,
        after: await boundary.read(key),
      };
    },
  };
}
