import { expect, vi } from 'vitest';
import { z } from 'zod';
import { TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1, TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { normalizePluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import {
  TriageGetResultV1Schema,
  TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 } from '../../../../packages/plugins/telemetry/src/exceptions/issueRecord';
import {
  TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1,
  TELEMETRY_EXCEPTION_SOURCE_V1,
} from '../../../../packages/plugins/telemetry/src/exceptions/source';
import {
  exceptionIssueTransitionResultSchema,
  exceptionOccurrencesReadResultSchema,
} from '../../../../packages/plugins/telemetry/src/exceptions/actions';

type Viewer = Readonly<{
  accountId: string;
  accepted(name: string, input: unknown): Promise<unknown>;
}>;
const sharedRowSchema = z.object({
  rowId: z.string(),
  ownerAccountId: z.string(),
  value: z.record(z.string(), z.unknown()),
});
const sharedListSchema = z.object({ rows: z.array(sharedRowSchema) });
const grantsSchema = z.object({
  grants: z.array(
    z
      .object({
        principal: z.record(z.string(), z.unknown()),
        accessLevel: z.string(),
      })
      .passthrough(),
  ),
});

/**
 * F18a: a real SDK app's recordException span event → collector ingest
 * (redacted occurrence) → the collector's single writer creates the Account
 * issue and shares it with the Project's Team (D34) → occurrence demand read →
 * deliberate resolve → qualifying recurrence regresses the same issue.
 * Every call is a credentialed Action through Home (Postgres) to the daemon.
 */
export async function runProductionExceptionsJourney(
  input: Readonly<{
    serverId: string;
    environmentId: string;
    appUrl: string;
    signal: AbortSignal;
    teamId: string;
    owner: Viewer;
    teammate: Viewer;
    acceptedOnCollector(name: string, value: unknown): Promise<unknown>;
  }>,
) {
  const instance = {
    v: 1,
    instance: {
      source: TELEMETRY_EXCEPTION_SOURCE_V1,
      sourceInstanceId: '6f1f37f4-2f0e-4a0e-9a35-1f8e0d6f7a18',
    },
    binding: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.binding,
    localInstanceKey: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.localInstanceKey,
    configuration: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.configuration,
  };
  const invoke = (localId: string, value: unknown) =>
    input.acceptedOnCollector('action.invoke', {
      action: { pluginId: TELEMETRY_EXCEPTION_SOURCE_V1.pluginId, localId },
      input: value,
    });
  const scan = async () => {
    const result = TriageScanResultV1Schema.parse(
      await invoke('exceptions/scan-v1', {
        v: 1,
        instance,
        page: { kind: 'initial', limit: 50 },
      }),
    );
    if (result.kind === 'failed')
      throw new Error(
        `F18a native source scan failed (${result.failure.code})`,
      );
    return result.observations.flatMap((row) =>
      row.kind === 'present' ? [row] : [],
    );
  };
  const request = async (path: string, status: number) => {
    const response = await fetch(new URL(path, input.appUrl), {
      signal: input.signal,
    });
    expect(response.status).toBe(status);
  };
  // G1: the admitted source read answers before any exception exists.
  await scan();
  const fail = async () => {
    await request('/checkout?fail=1', 500);
    await request('/flush', 200);
  };

  let issue: Awaited<ReturnType<typeof scan>>[number] | undefined;
  await vi.waitFor(
    async () => {
      await fail();
      issue = (await scan()).find(
        (row) => row.snapshot.scopeUnitId === input.environmentId,
      );
      expect(issue).toBeDefined();
    },
    { timeout: 30_000, interval: 1000 },
  );
  expect(issue!.snapshot.state).toMatchObject({
    presentation: 'active',
    nativeLabel: 'Open',
  });
  expect(issue!.snapshot.title).toContain('controlled F15 application failure');
  const rowId = issue!.localRef.entryId;
  const exact = TriageGetResultV1Schema.parse(
    await invoke('exceptions/get-v1', {
      v: 1,
      instance,
      localRef: issue!.localRef,
    }),
  );
  expect(exact.kind).toBe('present');

  // D34: the single writer armed the Project's Team grant; the teammate reads the owner's record, never a copy.
  const contract = normalizePluginAccountCollectionContractV1({
    pluginId: TELEMETRY_EXCEPTION_SOURCE_V1.pluginId,
    contribution: TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 as never,
  });
  const collectionRef = {
    pluginId: contract.pluginId,
    collectionId: contract.collectionId,
    schemaVersion: contract.schemaVersion,
    contractDigest: contract.contractDigest,
  };
  const grants = grantsSchema.parse(
    await input.owner.accepted('plugins.collections.shared.grants.list', {
      collectionRef,
      rowId,
    }),
  );
  expect(grants.grants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        principal: { kind: 'team', teamId: input.teamId },
        accessLevel: 'view',
      }),
    ]),
  );
  const shared = sharedListSchema.parse(
    await input.teammate.accepted('plugins.collections.shared.list', {
      collectionRef,
      sharedWithTeamId: input.teamId,
    }),
  );
  const teammateRow = shared.rows.find((row) => row.rowId === rowId);
  expect(teammateRow?.ownerAccountId).toBe(input.owner.accountId);
  const fingerprint = z.string().parse(teammateRow?.value.fingerprint);

  // Occurrence and stack are demand reads from the collector, through the Environment's R16 admission.
  const firstPage = exceptionOccurrencesReadResultSchema.parse(
    await invoke(databaseActionLocalIdV1(TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1),
      {
        serverId: input.serverId,
        environmentId: input.environmentId,
        fingerprint,
        page: { limit: 5 },
      },
    ),
  );
  if (firstPage.status !== 'ok' || firstPage.items.length === 0)
    throw new Error('F18a occurrences unavailable');
  const occurrence = firstPage.items[0]!;
  const withStack = exceptionOccurrencesReadResultSchema.parse(
    await invoke(databaseActionLocalIdV1(TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1),
      {
        serverId: input.serverId,
        environmentId: input.environmentId,
        fingerprint,
        page: { limit: 1 },
        occurrenceId: occurrence.id,
      },
    ),
  );
  expect(withStack.status === 'ok' && withStack.stacktrace).toEqual(
    expect.stringContaining('controlled F15 application failure'),
  );
  expect(JSON.stringify(withStack)).not.toContain('must-be-masked');

  // Resolve naming the current release as the fix: its recurrence is qualifying and regresses the SAME issue.
  const release = occurrence.serviceVersion ?? 'unknown-release';
  const resolved = exceptionIssueTransitionResultSchema.parse(
    await invoke(databaseActionLocalIdV1(TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1),
      {
        serverId: input.serverId,
        environmentId: input.environmentId,
        issueId: rowId,
        action: 'resolve',
        version: release,
      },
    ),
  );
  expect(resolved).toMatchObject({
    status: 'applied',
    issue: { status: 'resolved' },
  });
  expect(
    (await scan()).find((row) => row.localRef.entryId === rowId)?.snapshot.state
      .presentation,
  ).toBe('resolved');
  await vi.waitFor(
    async () => {
      await fail();
      const row = (await scan()).find(
        (candidate) => candidate.localRef.entryId === rowId,
      );
      expect(row?.snapshot.state).toMatchObject({
        presentation: 'active',
        nativeLabel: 'Regressed',
      });
    },
    { timeout: 30_000, interval: 1000 },
  );
  expect(
    (await scan()).filter(
      (row) => row.snapshot.scopeUnitId === input.environmentId,
    ),
  ).toHaveLength(1);
  console.info(
    'F18a native exception issue opened, shared, read, resolved and regressed',
    {
      environmentId: input.environmentId,
      issueId: rowId,
      release,
      occurrences: firstPage.items.length,
    },
  );
}
