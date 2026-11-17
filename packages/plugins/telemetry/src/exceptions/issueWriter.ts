import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginAccountCollectionForDefinition,
  PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';
import type { CaptureExceptionGroup, createCaptureStore } from '../store/capture.js';
import {
  isQualifyingRecurrence,
  openExceptionIssue,
  refreshExceptionIssue,
  regressExceptionIssue,
  transitionExceptionIssue,
  TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
  type ExceptionIssuePhase,
  type ExceptionIssueRecord,
  type ExceptionIssueTransitionAction,
} from './issueRecord.js';

export type ExceptionIssueCollection = PluginAccountCollectionForDefinition<
  typeof TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1
>;
type Store = Pick<
  ReturnType<typeof createCaptureStore>,
  'exceptionGroups' | 'exceptionVersions' | 'exceptionRecurrence'
>;
export type ExceptionIssueRow = PluginCollectionRow<ExceptionIssueRecord>;
export type ExceptionIssueEnvironment = Readonly<{
  partition: string;
  environmentId: string;
}>;
/** Published only after the Account write committed; count-only changes never reach it. */
export type ExceptionIssueTransition = Readonly<{
  phase: ExceptionIssuePhase;
  row: ExceptionIssueRow;
  regressed: boolean;
}>;
export type ExceptionIssueProjectionStatus = Readonly<
  { state: 'ready' } | { state: 'unavailable'; code: string }
>;
export type ExceptionIssueTransitionOutcome = Readonly<
  | { kind: 'absent' }
  | { kind: 'unchanged'; row: ExceptionIssueRow }
  | { kind: 'applied'; row: ExceptionIssueRow }
>;

const UNAVAILABLE = 'telemetry_issue_projection_unavailable';
const CONFLICT = 'plugin_collection_conflict';

function signalAborted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function failureCode(error: unknown): string {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : UNAVAILABLE;
}

/**
 * The ONE native issue writer, on the collector daemon under its signed-in
 * Account. Ingest commits raw occurrences first; this writer then creates or
 * regresses Account records for affected groups only, and every lifecycle edit
 * (Resolve, Reopen, Ignore) arrives here through Machine Action transport.
 * Writes are serialized, so its own row projection stays current; a revision
 * conflict re-reads the row once from the Account owner.
 */
export function createExceptionIssueWriter(
  options: Readonly<{
    issues: ExceptionIssueCollection;
    store: Store;
    publish: (transition: ExceptionIssueTransition) => Promise<void>;
    /** D34: arms the Environment's Team grant on each record this writer creates. */
    share?: (row: ExceptionIssueRow) => Promise<void>;
    now?: () => number;
  }>,
) {
  const now = options.now ?? Date.now;
  const known = new Map<string, ExceptionIssueRow | null>();
  let tail: Promise<unknown> = Promise.resolve();
  let status: ExceptionIssueProjectionStatus = { state: 'ready' };

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(() => settle(operation));
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  async function settle<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      status = { state: 'ready' };
      return result;
    } catch (error) {
      status = { state: 'unavailable', code: failureCode(error) };
      throw error;
    }
  }
  function rowId(environmentId: string, fingerprint: string): Promise<string> {
    // Row ids are server-readable; the Account-mode identity tag keeps app error text out of them.
    return options.issues.identityTag({
      field: 'id',
      components: [environmentId, fingerprint],
    });
  }
  async function read(
    id: string,
    fresh = false,
  ): Promise<ExceptionIssueRow | null> {
    if (!fresh && known.has(id)) return known.get(id)!;
    const row = await options.issues.get(id);
    known.set(id, row);
    return row;
  }
  async function write(
    id: string,
    next: (current: ExceptionIssueRow | null) => ExceptionIssueRecord | null,
  ): Promise<ExceptionIssueRow | null> {
    for (const fresh of [false, true]) {
      const current = await read(id, fresh);
      const value = next(current);
      if (value === null) return null;
      try {
        const row = await options.issues.put(value, {
          expectedRevision: current?.revision ?? 'absent',
        });
        known.set(id, row);
        return row;
      } catch (error) {
        known.delete(id);
        if (fresh || failureCode(error) !== CONFLICT) throw error;
      }
    }
    return null;
  }

  async function observeGroups(
    environment: ExceptionIssueEnvironment,
    groups: readonly CaptureExceptionGroup[],
  ): Promise<void> {
    let shareFailure: string | undefined;
    for (const group of groups) {
      const id = await rowId(environment.environmentId, group.fingerprint);
      const current = await read(id);
      if (current === null) {
        const row = await write(id, (existing) =>
          existing
            ? null
            : openExceptionIssue({
                id,
                environmentId: environment.environmentId,
                group,
                now: now(),
              }),
        );
        if (!row) continue;
        if (options.share) {
          // A failed grant never withholds the owner's issue or its transition; the typed status reports it.
          try { await options.share(row); }
          catch (error) { if (signalAborted(error)) throw error; shareFailure = failureCode(error); }
          // Arming a grant re-keys the row on the Account owner; read its new revision on next touch.
          known.delete(id);
        }
        await options.publish({ phase: 'open', row, regressed: false });
        continue;
      }
      const resolution =
        current.value.status === 'resolved'
          ? current.value.resolution
          : undefined;
      if (!resolution) continue;
      const recurrence = await options.store.exceptionRecurrence(
        environment.partition,
        group.fingerprint,
        resolution.atMs,
        resolution.priorVersions,
      );
      if (!recurrence) continue;
      const row = await write(id, (existing) =>
        existing && isQualifyingRecurrence(existing.value, recurrence)
          ? regressExceptionIssue(existing.value, group, now())
          : null,
      );
      if (row) await options.publish({ phase: 'open', row, regressed: true });
    }
    if (shareFailure) throw new PluginError({ code: 'telemetry_issue_share_unavailable', message: `Team sharing failed: ${shareFailure}` });
  }

  return {
    status: (): ExceptionIssueProjectionStatus => status,
    /** Affected groups after a committed ingest batch. New → open; qualifying recurrence → regressed (phase open). */
    observe(
      environment: ExceptionIssueEnvironment,
      fingerprints: readonly string[],
    ): Promise<void> {
      if (fingerprints.length === 0) return Promise.resolve();
      return serial(async () =>
        observeGroups(environment, await options.store.exceptionGroups({ worktree: environment.partition, fingerprints, limit: fingerprints.length })),
      );
    },
    /** A deliberate lifecycle edit; a resolution records the releases already seen. */
    transition(
      input: Readonly<{
        environment: ExceptionIssueEnvironment;
        rowId: string;
        action: ExceptionIssueTransitionAction;
        version?: string;
      }>,
    ): Promise<ExceptionIssueTransitionOutcome> {
      return serial(async (): Promise<ExceptionIssueTransitionOutcome> => {
        const current = await read(input.rowId, true);
        if (
          !current ||
          current.value.environmentId !== input.environment.environmentId
        )
          return { kind: 'absent' };
        const priorVersions =
          input.action === 'resolve'
            ? (
                await options.store.exceptionVersions(
                  input.environment.partition,
                  current.value.fingerprint,
                )
              ).filter((version): version is string => version !== null)
            : [];
        let phase: ExceptionIssuePhase | undefined;
        const row = await write(input.rowId, (existing) => {
          if (!existing) return null;
          const result = transitionExceptionIssue(
            existing.value,
            input.action,
            { now: now(), version: input.version, priorVersions },
          );
          phase = result?.phase;
          return result?.record ?? null;
        });
        if (!row) return { kind: 'unchanged', row: current };
        if (phase) await options.publish({ phase, row, regressed: false });
        return { kind: 'applied', row };
      });
    },
    /** Demand refresh of one issue's counts with their as-of time; lifecycle untouched. */
    refresh(
      input: Readonly<{
        environment: ExceptionIssueEnvironment;
        rowId: string;
      }>,
    ): Promise<ExceptionIssueRow> {
      return serial(async () => {
        const current = await read(input.rowId, true);
        if (
          !current ||
          current.value.environmentId !== input.environment.environmentId
        ) {
          throw new PluginError({
            code: 'telemetry_issue_not_found',
            message: 'The issue is not available on this collector.',
          });
        }
        const [group] = await options.store.exceptionGroups({
          worktree: input.environment.partition,
          fingerprints: [current.value.fingerprint],
          limit: 1,
        });
        if (!group) return current;
        return (
          (await write(input.rowId, (existing) =>
            existing
              ? refreshExceptionIssue(existing.value, group, now())
              : null,
          )) ?? current
        );
      });
    },
    /** Recovery after Account storage was unavailable: replay retained groups idempotently. */
    replay(
      environment: ExceptionIssueEnvironment,
      pageSize: number,
    ): Promise<void> {
      return serial(async () => {
        // Every retained group, newest first, one host-bounded page at a time.
        let after: Readonly<{ lastAt: number; fingerprint: string }> | undefined;
        for (;;) {
          const page = await options.store.exceptionGroups({ worktree: environment.partition, limit: pageSize, ...(after ? { after } : {}) });
          await observeGroups(environment, page);
          const last = page.at(-1);
          if (!last || page.length < pageSize) return;
          after = { lastAt: last.lastAt, fingerprint: last.fingerprint };
        }
      });
    },
  };
}
export type ExceptionIssueWriter = ReturnType<
  typeof createExceptionIssueWriter
>;
