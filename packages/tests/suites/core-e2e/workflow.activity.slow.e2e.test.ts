import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { WorkflowRunGetResultV1Schema, WorkflowRunListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { waitFor } from '../../src/testkit/timing';
import type { WorkflowActivityLiveFact } from '../../../../apps/ui/sources/sync/domains/workflows/workflowActivityTypes';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

describe('Workflow activity through the Account Action executor', () => {
  let fixture: TeamSetupFFixture;
  let account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  beforeAll(async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'workflow-activity-')),
      dbProvider: 'postgres', observeActionRequests: true,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
    account = await fixture.createAccount('activity-reader');
  }, 0);
  afterAll(async () => { await fixture?.stop(); }, 0);

  it('P01.F5 two Events hosts share live demand', async () => {
    machine = await fixture.enrollDaemon(account, { env: {
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    } });
    await fixture.assertKnownGoodSessionControl(account, machine);

    const retained = await account.execute('workflow.run.list', { projection: 'membership' });
    expect(retained.ok).toBe(true);
    // The Action id is intentionally exercised before its catalog producer in RED.
    const activity = await account.execute('workflow.activity.list' as ActionId, {});
    expect(activity.ok).toBe(true);
    if (!activity.ok || !retained.ok) throw new Error('Activity read unavailable');
    expect(activity.result).toEqual({ retained: retained.result,
      live: { kind: 'unavailable', reason: 'ui_local_only' } });
    expect(await account.execute('workflow.activity.list' as ActionId, { targetSessionId: 'private-selector' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });

    const ui = await connectUiActionClient({ serverUrl: fixture.actionServerApiUrl, addressAnchorUrl: fixture.server.baseUrl, credentials: account.uiCredentials });
    const releases: (() => void)[] = [];
    try {
      await waitFor(() => ui.isAccountReady(), { timeoutMs: 60_000 });
      const sourceModule = '../../../../apps/ui/sources/sync/engine/workflows/workflowActivitySource.ts';
      const { getWorkflowActivitySource } = await import(sourceModule);
      const source = getWorkflowActivitySource();
      if (!source) throw new Error('Active UI Account lifetime unavailable');
      expect(getWorkflowActivitySource()).toBe(source);
      expect(source.hasDemand()).toBe(false);
      const column: WorkflowActivityLiveFact[] = [];
      const companion: WorkflowActivityLiveFact[] = [];
      let columnPage: unknown;
      let companionPage: unknown;
      let columnRetainedUpdates = 0;
      fixture.takeRequestObservations();
      releases.push(source.acquire({ onLive: (rows: readonly WorkflowActivityLiveFact[]) => column.push(...rows), onRetained: (page: unknown) => { columnPage = page; columnRetainedUpdates += 1; } }));
      releases.push(source.acquire({ onLive: (rows: readonly WorkflowActivityLiveFact[]) => companion.push(...rows), onRetained: (page: unknown) => { companionPage = page; } }));
      await waitFor(() => columnPage !== undefined && companionPage !== undefined, { timeoutMs: 60_000 });
      expect(columnPage).toBe(companionPage);
      expect(column).toEqual([]); // The opening snapshot is a baseline, never historical events.
      const baselineReads = fixture.takeRequestObservations().filter(request => request.path === '/v3/automations/runs/workflow-storage');
      expect(baselineReads).toHaveLength(1);
      await source.retry();
      expect(columnRetainedUpdates).toBe(1);
      expect(fixture.takeRequestObservations().filter(request => request.path === '/v3/automations/runs/workflow-storage'))
        .toHaveLength(1); // Explicit Retry reads once without republishing the unchanged page.
      const created = await fixture.assertKnownGoodSessionControl(account, machine);
      await waitFor(() => column.some(row => row.kind === 'session' && row.event === 'started' && row.sessionId === created.sessionId), { timeoutMs: 60_000 });
      expect(companion).toEqual(column);
      expect(column.filter(row => row.kind === 'session' && row.event === 'started' && row.sessionId === created.sessionId)).toHaveLength(1);
      // Both hosts consume the same pushed row object; neither asks HTTP for its body.
      expect(companion.at(-1)).toBe(column.at(-1));
      expect(fixture.takeRequestObservations().filter(request => request.path === '/v3/automations/runs/workflow-storage'))
        .toEqual([]);

      const privateDocument = 'PRIVATE-ACTIVITY-DEFINITION';
      const authored = await ui.executeConfirmed('workflow.trigger.add', {
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        target: { kind: 'inline', definition: { version: 1,
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ kind: 'step', id: 'observe', document: { text: privateDocument, references: [], attachments: [] },
            input: [], result: { kind: 'text' } }],
        } },
        trigger: { kind: 'schedule', enabled: true,
          schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
      }, { serverId: ui.serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
      expect(authored.ok, JSON.stringify(authored)).toBe(true);
      if (!authored.ok) throw new Error(authored.errorCode);
      const set = WorkflowTriggerWriteResultV1Schema.parse(authored.result).set;
      expect(await ui.executeConfirmed('workflow.trigger.run_now', { automationId: set.automationId },
        { serverId: ui.serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
        .toMatchObject({ ok: true });
      let occurrenceId: string | undefined;
      await waitFor(async () => {
        const read = await source.readPage({ automationId: set.automationId });
        const runs = WorkflowRunListResultV1Schema.parse(read).runs;
        const run = runs[0];
        // The accepted snapshot exists once the Workflow execution owner initializes the Run.
        occurrenceId = run && (run.state === 'running' || run.state === 'succeeded') ? run.id : undefined;
        expect(JSON.stringify(read)).not.toContain(privateDocument);
        return occurrenceId !== undefined;
      }, { timeoutMs: 60_000 });
      if (!occurrenceId) throw new Error('Daemon-backed occurrence unavailable');
      const detail = await account.execute('workflow.run.get', { runId: occurrenceId });
      expect(detail.ok, detail.ok ? undefined : detail.errorCode).toBe(true);
      if (!detail.ok) throw new Error(detail.errorCode);
      const opened = WorkflowRunGetResultV1Schema.parse(detail.result);
      expect(opened.run.origin).toMatchObject({ kind: 'automation', automationId: set.automationId, cause: { kind: 'manual' } });
      expect(JSON.stringify(opened.definition)).toContain(privateDocument);
      for (const release of releases.splice(0)) release();
      expect(source.hasDemand()).toBe(false);
      const beforeClosed = column.length;
      fixture.takeRequestObservations();
      await fixture.assertKnownGoodSessionControl(account, machine);
      expect(column).toHaveLength(beforeClosed);
      expect(companion).toHaveLength(beforeClosed);
      expect(fixture.takeRequestObservations().filter(request => request.path === '/v3/automations/runs/workflow-storage'))
        .toEqual([]);
      const reopened: WorkflowActivityLiveFact[] = [];
      let reopenedPage: unknown;
      releases.push(source.acquire({ onLive: (rows: readonly WorkflowActivityLiveFact[]) => reopened.push(...rows),
        onRetained: (page: unknown) => { reopenedPage = page; } }));
      await waitFor(() => reopenedPage !== undefined, { timeoutMs: 60_000 });
      expect(reopened).toEqual([]); // Closed-period Sessions remain baseline on reopen.
      await source.retry();
      expect(reopened).toEqual([]); // An unchanged retained refresh never invents live occurrences.
      const { apiSocket } = await import('../../../../apps/ui/sources/sync/api/session/apiSocket');
      let connected = false;
      releases.push(apiSocket.onStatusChange(status => { connected = status === 'connected'; }));
      apiSocket.disconnect({ preserveHttpRequests: true });
      expect(connected).toBe(false);
      apiSocket.connect();
      await waitFor(() => connected, { timeoutMs: 60_000 });
      expect(getWorkflowActivitySource()).toBe(source);
      await source.retry();
      expect(reopened).toEqual([]); // Reattaching the same Account's unchanged facts is not a new occurrence.
      const afterReconnect = await fixture.assertKnownGoodSessionControl(account, machine);
      await waitFor(() => reopened.some(row => row.kind === 'session' && row.event === 'started' && row.sessionId === afterReconnect.sessionId),
        { timeoutMs: 60_000 });
      expect(reopened.filter(row => row.kind === 'session' && row.event === 'started' && row.sessionId === afterReconnect.sessionId)).toHaveLength(1);
    } finally {
      for (const release of releases) release();
      await ui.close();
    }
  }, 0);
});
