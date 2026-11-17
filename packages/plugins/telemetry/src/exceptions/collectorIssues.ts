import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import type { CaptureRuntime } from '../runtime.js';
import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 } from './issueRecord.js';
import {
  createExceptionIssueWriter,
  type ExceptionIssueEnvironment,
  type ExceptionIssueRow,
  type ExceptionIssueTransition,
  type ExceptionIssueWriter,
} from './issueWriter.js';

let current: ExceptionIssueWriter | null = null;

/** The collector's one native issue writer, when its daemon has Account storage. */
export function readExceptionIssueWriter(): ExceptionIssueWriter | null {
  return current;
}

/**
 * Started by the collector runner under the daemon's signed-in Account. Without
 * Account storage there is no writer: raw occurrences stay on the collector and
 * lifecycle Actions answer `telemetry_issue_writer_unavailable`.
 */
export function startCollectorIssueProjection(
  input: Readonly<{
    account: PluginAccountStorageScope | undefined;
    runtime: CaptureRuntime;
    publish: (transition: ExceptionIssueTransition) => Promise<void>;
    /** D34: the Team owning this Environment's Project, from the collector's current assignment. */
    teamOf: (environmentId: string) => string | undefined;
  }>,
): Readonly<{
  observe(
    environment: ExceptionIssueEnvironment,
    fingerprints: readonly string[],
  ): void;
  stop(): void;
}> {
  if (!input.account) return { observe() {}, stop() {} };
  const issues = input.account.collection(TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1);
  // The existing Collection sharing owner keys the row and seals recipient envelopes; grantees only read.
  const share = async (row: ExceptionIssueRow) => {
    const teamId = input.teamOf(row.value.environmentId);
    if (teamId === undefined) return;
    await issues.sharing.setGrant(row.rowId, { principal: { kind: 'team', teamId }, accessLevel: 'view', expectedRevision: row.revision });
  };
  const writer = createExceptionIssueWriter({ issues, store: input.runtime.store, publish: input.publish, share });
  current = writer;
  return {
    // The OTLP response never waits for Account publication; a failure is the writer's typed status.
    observe(environment, fingerprints) {
      void writer.observe(environment, fingerprints).catch(() => {});
    },
    stop() {
      if (current === writer) current = null;
    },
  };
}
