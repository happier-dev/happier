import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { expect } from 'vitest';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { AutomationEventActionHttpPathsV1, AutomationEventActionHttpRequestSchemasV1 } from '@happier-dev/protocol/automations/event';
import { automationEventSourceCatalogScopeKeyV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { signPluginInstallationPublisherHeader } from '../../../../apps/cli/src/plugins/installations/publisherProof';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { attachMachineEventTrigger } from './automationsEverywhereGuardStop';
import { fetchJson } from './http';
import { createServerLightDatabaseClient } from './process/serverLightDatabase';
import { createUserScopedSocketCollector } from './socketClient';
import type { TeamSetupFFixture } from './teamSetupF';
import { waitFor } from './timing';

const rowSchema = z.record(z.string(), z.unknown());
const censusRowSchema = z.object({ probe: z.string(), committed: z.boolean(),
  fencedRevisionReads: z.number(), fencedDeclarationOrTargetReads: z.number(),
  coverageWrites: z.number(), sourceWrites: z.number(), automationPublications: z.number() });

/** The same composed server, authenticated daemon installation and native PG transaction.
 * Replay at its HTTP trust boundary; admission, declarations, target checks and publication stay real. */
export async function assertAutomationStatusPublicationEconomy(params: Readonly<{
  fixture: TeamSetupFFixture;
  owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  censusPath: string;
}>) {
  const { fixture, owner, machine } = params;
  const { saved } = await attachMachineEventTrigger(fixture, owner, machine, 'guard-stopped');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Composed PostgreSQL DATABASE_URL is required');
  // Prisma 7: the server's construction owner builds the client (driver adapter).
  const database = await createServerLightDatabaseClient('postgres', databaseUrl);
  const socket = createUserScopedSocketCollector(fixture.server.baseUrl, owner.credentials.token);
  const accountId = readAccountIdFromToken(owner.credentials.token);
  const identity = MachineInstallationIdentityV1Schema.parse(JSON.parse(
    await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
  const rows = async (sql: string, ...values: unknown[]) =>
    z.array(rowSchema).parse(await database.$queryRawUnsafe(sql, ...values));
  try {
    const [source] = await rows(`SELECT s.*, t."automationId", t."revision" AS "currentTriggerRevision"
      FROM "AutomationEventSourceStatus" s JOIN "AutomationTrigger" t ON t."id" = s."triggerId"
      JOIN "Automation" a ON a."id" = t."automationId"
      WHERE s."triggerId" = $1 AND a."accountId" = $2 AND s."reporterMachineId" = $3`,
    saved.triggerId, accountId, machine.target.machineId);
    if (!source) throw new Error('Real daemon source status must exist before its report probes');
    const caller = { pluginId: source.eventPluginId, occurrenceId: randomUUID(),
      materialization: { machineId: machine.target.machineId,
        pluginId: source.eventPluginId, materializationId: source.reporterMaterializationId },
      sourceCustody: source.reporterSourceCustody };
    const scope = { kind: 'checkpointedPull' } as const;
    const catalogRows = () => rows(`SELECT to_jsonb(s) AS snapshot,
      s."observedRevision"::text AS "observedRevision", s."adoptedRevision"::text AS "adoptedRevision",
      s."state", s."scanStartedAt", s."nextRetryAt", s."revision"
      FROM "AutomationEventSourceCatalogStatus" s WHERE s."accountId" = $1
      AND s."eventPluginId" = $2 AND s."reporterMachineId" = $3
      AND s."reporterMaterializationId" = $4 AND s."scopeKey" = $5`, accountId, source.eventPluginId,
    machine.target.machineId, source.reporterMaterializationId, automationEventSourceCatalogScopeKeyV1(scope));
    let catalog: Record<string, unknown> | undefined;
    await waitFor(async () => { [catalog] = await catalogRows(); return catalog?.state === 'current'; },
      { context: 'Real daemon settles its checkpointed-pull catalog coverage as current' });
    if (!catalog) throw new Error('Real daemon catalog status is missing');
    const currentCatalog = catalog;
    const timestamp = (value: unknown) => value === null ? null : z.date().parse(value).getTime();
    const scanStartedAt = timestamp(currentCatalog.scanStartedAt) ?? Date.now();
    const catalogInput = { kind: 'catalogReconciliation', scope,
      observedRevision: currentCatalog.observedRevision, adoptedRevision: currentCatalog.adoptedRevision,
      state: currentCatalog.state, scanStartedAt, nextRetryAt: timestamp(currentCatalog.nextRetryAt) };
    const readChange = () => rows(`SELECT to_jsonb(c) AS snapshot, c."cursor"::text AS cursor
      FROM "AccountChange" c WHERE c."accountId" = $1 AND c."kind" = 'automation'
      AND c."entityId" = 'automation-source-status'`, accountId);
    const census = async (probe: string) => {
      const entries = (await readFile(params.censusPath, 'utf8')).trim().split('\n').filter(Boolean)
        .map(line => censusRowSchema.parse(JSON.parse(line))).filter(row => row.probe === probe);
      return entries;
    };
    const report = async (input: unknown) => {
      const probe = randomUUID();
      const path = AutomationEventActionHttpPathsV1['automation.event.source.status.report'];
      const body = AutomationEventActionHttpRequestSchemasV1['automation.event.source.status.report'].parse({ v: 1, caller, input });
      const response = await fetchJson(`${fixture.server.baseUrl}${path}`, { method: 'POST',
        headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json',
          'x-happier-e2e-status-probe': probe,
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: signPluginInstallationPublisherHeader({
            identity, machineId: machine.target.machineId, path, body }) }, body: JSON.stringify(body) });
      return { response, transactions: await census(probe) };
    };
    const publicationEconomy = (transactions: Awaited<ReturnType<typeof census>>) => {
      expect(transactions.length, 'Accepted report must enter the observed PostgreSQL boundary').toBeGreaterThan(0);
      expect(transactions.every(row => row.fencedDeclarationOrTargetReads === 0)).toBe(true);
      expect(transactions.filter(row => row.committed).reduce((sum, row) => sum + row.fencedRevisionReads, 0)).toBe(1);
    };
    socket.connect();
    await waitFor(() => socket.isConnected(), { context: 'Account socket observes real status publication' });
    const sourceInput = { kind: 'source', automationId: source.automationId, triggerId: saved.triggerId,
      triggerRevision: source.currentTriggerRevision, eventRef: { pluginId: source.eventPluginId, localId: source.eventLocalId },
      sourceSelectorId: source.sourceSelectorId, state: 'observing', code: 'none', nextRetryAt: null,
      observedDelta: 1, admittedDelta: 0, skippedDelta: 1 };
    const sourceChanged = await report(sourceInput);
    expect(sourceChanged.response.status).toBe(200);
    publicationEconomy(sourceChanged.transactions);
    expect(sourceChanged.transactions.filter(row => row.committed).reduce((sum, row) => sum + row.sourceWrites, 0)).toBe(1);
    expect(sourceChanged.transactions.filter(row => row.committed).reduce((sum, row) => sum + row.automationPublications, 0)).toBe(1);
    await waitFor(() => socket.getEvents().some(event => event.kind === 'update'
      && event.payload.body?.t === 'automation-source-status-updated'),
    { context: 'Real source report publishes its committed status' });
    const baselineChanges = await readChange();
    const scan = await report({ ...catalogInput, scanStartedAt: scanStartedAt + 1 });
    expect(scan.response.status).toBe(200);
    expect(scan.transactions.length, 'Accepted scan-only report must reach real PostgreSQL').toBeGreaterThan(0);
    expect((await catalogRows())[0]?.snapshot).toEqual(currentCatalog.snapshot);
    expect(await readChange()).toEqual(baselineChanges);
    expect(scan.transactions.every(row => row.coverageWrites === 0 && row.automationPublications === 0)).toBe(true);
    const missingTriggerId = randomUUID();
    const absent = await report({ ...sourceInput, triggerId: missingTriggerId });
    expect(absent.response).toMatchObject({ status: 409, data: { error: 'definition_not_current' } });
    expect(absent.transactions.every(row => row.sourceWrites === 0 && row.automationPublications === 0)).toBe(true);
    expect(await rows('SELECT "triggerId" FROM "AutomationEventSourceStatus" WHERE "triggerId" = $1', missingTriggerId)).toEqual([]);
    expect(await readChange()).toEqual(baselineChanges);
    const changed = await report({ ...catalogInput, state: 'reconciling', adoptedRevision: null,
      scanStartedAt: scanStartedAt + 2 });
    expect(changed.response.status).toBe(200);
    publicationEconomy(changed.transactions);
    expect(changed.transactions.filter(row => row.committed).reduce((sum, row) => sum + row.coverageWrites, 0)).toBe(1);
    expect(changed.transactions.filter(row => row.committed).reduce((sum, row) => sum + row.automationPublications, 0)).toBe(1);
    expect((await catalogRows())[0]?.revision).toBe(z.number().parse(currentCatalog.revision) + 1);
    const afterChanges = await readChange();
    expect(BigInt(z.string().parse(afterChanges[0]?.cursor))).toBeGreaterThan(BigInt(z.string().parse(baselineChanges[0]?.cursor)));
    const cursor = Number(z.string().parse(afterChanges[0]?.cursor));
    await waitFor(() => socket.getEvents().some(event => event.kind === 'update'
      && event.payload.body?.t === 'automation-source-status-updated' && event.payload.seq === cursor),
    { context: 'Changed coverage publishes the same committed cursor to the Account socket' });
    // Match the committed cursor; other Account change kinds may legitimately allocate between reports.
    expect(socket.getEvents().filter(event => event.kind === 'update'
      && event.payload.body?.t === 'automation-source-status-updated' && event.payload.seq === cursor)).toHaveLength(1);
  } finally {
    socket.close();
    try {
      expect(await owner.execute('workflow.trigger.remove', { automationId: saved.set.automationId,
        triggerId: saved.triggerId }, { presentUserConfirmation: { actionId: 'workflow.trigger.remove' } }))
        .toMatchObject({ ok: true });
    } finally {
      await database.$disconnect();
    }
  }
}
