import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { applyTrustedLocalPluginFixture, reloadTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { readWorkflowChildSession } from '../../src/testkit/workflowChildSession';
import { installExternalTicketAutomationFixture } from '../../src/testkit/pluginPlatform/externalTicketAutomationFixture';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { captureActiveServerAccountScopeLifetime } from '../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope';
import { acquireDaemonMergedWorkflowActionCatalog, loadDaemonMergedProjectionCacheEntry } from '../../../../apps/ui/sources/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readAutomationSubjectPickerActionPage } from '../../../../apps/ui/sources/sync/domains/workflows/automationSubjectPicker';
import { listWorkflowStepActionSpecs } from '../../../../apps/ui/sources/components/workflows/presentation/workflowActionCatalog';

describe('Automations everywhere: qualified plugin subjects', () => {
  const run = createRunDirs({ runLabel: 'automations-p01-f7' });
  let fixture: TeamSetupFFixture | undefined;
  let otherHome: TeamSetupFFixture | undefined;
  afterEach(async () => {
    await Promise.all([fixture?.stop(), otherHome?.stop()]);
    fixture = undefined;
    otherHome = undefined;
  }, 0);

  it('P01.F7 qualified plugin subject through public UI', async () => {
    const testDir = run.testDir('qualified-plugin-subject');
    const pluginIds = ['acme.tickets', 'other.tickets'] as const;
    fixture = await startTeamSetupFFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: '1' } });
    const actor = await fixture.createAccount('ticket-owner');
    const reader = await fixture.createAccount('ticket-reader');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const readerMachine = await fixture.enrollDaemon(reader, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    // This Machine-scoped read exercises the real Home/daemon without requiring
    // a pre-existing Session; Workflow effects below must produce their own.
    const control = await actor.executeAsPerson('workflow.events.list', machine.target);
    expect(control.ok, JSON.stringify(control)).toBe(true);
    if (!control.ok) throw new Error(`Ticket Machine control refused (${control.errorCode})`);
    expect(WorkflowEventsListOutputV1Schema.parse(control.result).machineId).toBe(machine.target.machineId);
    for (const pluginId of pluginIds) {
      const installed = await installExternalTicketAutomationFixture({ testDir,
        uiBaseUrl: fixture.server.baseUrl, daemon: machine.daemon }, pluginId);
      await applyTrustedLocalPluginFixture({ daemonPort: readerMachine.daemon.state.httpPort,
        controlToken: readerMachine.daemon.state.controlToken, pluginRoot: installed.pluginRoot, pluginId,
        interactionId: `ticket-reader-install-${pluginId}` });
    }
    const context = { externalActionTarget: { kind: 'machine' as const,
      machineId: machine.target.machineId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } };
    const pickerClient = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
      accountSecret: actor.auth.accountSigningSeed });
    let selectedTicket: import('@happier-dev/protocol/automations/automationSubjectV1').AutomationSubjectV1;
    try {
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime) throw new Error('Ticket picker Account lifetime unavailable');
      const entry = await loadDaemonMergedProjectionCacheEntry({ machineId: machine.target.machineId,
        serverId: pickerClient.serverId, accountLifetime: lifetime, sections: ['actionsById', 'familiesById.subjectKinds'] });
      if (entry?.kind !== 'ready') throw new Error('Ticket picker contribution projection unavailable');
      const inputs = entry.inputs;
      const catalog = acquireDaemonMergedWorkflowActionCatalog(entry);
      try {
        const specs = listWorkflowStepActionSpecs(inputs.pluginProjectionV2, inputs.pluginUiProjection,
          undefined, await catalog.promise, 'after');
        expect(specs.find(spec => spec.id === formatQualifiedPluginActionId({ pluginId: pluginIds[0], localId: 'close-ticket' })))
          .toMatchObject({ subjectKind: { ok: true, subjectKind: {
            kind: 'plugin', pluginId: pluginIds[0], subjectKindId: 'ticket', definition: { listAction: 'list-tickets' },
          } } });
      } finally { catalog.release(); }
      const page = await readAutomationSubjectPickerActionPage({
        kind: { kind: 'plugin', pluginId: pluginIds[0], subjectKindId: 'ticket' }, lifetime,
        page: { limit: 20 }, subjectKinds: Object.values(inputs.pluginUiProjection.subjectKindsById),
        context: { ...context, executeChildAction: pickerClient.executeConfirmed },
      });
      expect(page).toMatchObject({ items: expect.arrayContaining([{ label: 'Fix the checkout', subject: {
        kind: 'plugin', serverId: pickerClient.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket',
        identity: { ticketId: 'ticket-1' },
      } }]), nextCursor: null, coverage: 'complete' });
      const selected = page.items.find(item => item.label === 'Fix the checkout')?.subject;
      if (!selected) throw new Error('Ticket picker selection unavailable');
      selectedTicket = selected;
    } finally { await pickerClient.close(); }
    const workflowId = randomUUID();
    expect(await actor.executeAsPerson('workflow.definition.create', { definitionId: workflowId,
      metadata: { name: 'Shared ticket review' }, definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the ticket.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } })).toMatchObject({ ok: true });
    expect(await actor.executeAsPerson('artifact.access.grants.set', { artifactId: workflowId,
      principal: { kind: 'account', accountId: readAccountIdFromToken(reader.credentials.token) }, accessLevel: 'view' }))
      .toMatchObject({ ok: true });
    // The shared Workflow is real; sharing it must not create a grant owner for plugin identities.
    expect(await actor.executeAsPerson('workflow.definition.get', { definitionId: workflowId })).toMatchObject({ ok: true });
    const linked = await actor.executeAsPerson('workflow.trigger.add', {
      workflow: workflowId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true,
        actionIds: pluginIds.map(pluginId => formatQualifiedPluginActionId({ pluginId, localId: 'close-ticket' })),
        subject: selectedTicket },
    }, context);
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(`Ticket attachment refused (${linked.errorCode})`);
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    expect(saved.set.triggers).toContainEqual(expect.objectContaining({ subject: {
      kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' },
    } }));
    const before = await actor.executeAsPerson('workflow.trigger.add', {
      workflow: workflowId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'notify', enabled: true,
        actionIds: pluginIds.map(pluginId => formatQualifiedPluginActionId({ pluginId, localId: 'close-ticket' })),
        subject: { kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' } } },
    }, context);
    expect(before.ok, JSON.stringify(before)).toBe(true);
    if (!before.ok) throw new Error(`Before-ticket attachment refused (${before.errorCode})`);
    const beforeSaved = WorkflowTriggerWriteResultV1Schema.parse(before.result);
    const automationIds = [...new Set([saved.set.automationId, beforeSaved.set.automationId])];
    const runs = async () => {
      const pages = await Promise.all(automationIds.map(async automationId => {
        const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, {
          headers: { Authorization: `Bearer ${actor.credentials.token}`,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
        });
        expect(response.status).toBe(200);
        return AutomationV3RunListResponseSchema.parse(response.data).runs;
      }));
      return pages.flat();
    };
    const close = (pluginId: string, ticketId: string) => actor.executeAsPerson('action.invoke', {
      action: { pluginId, localId: 'close-ticket' }, input: { ticket: { ticketId } },
    }, context);
    expect(await close(pluginIds[1], 'ticket-1')).toMatchObject({ ok: true });
    expect(await close(pluginIds[0], 'another-ticket')).toMatchObject({ ok: true });
    expect(await runs()).toEqual([]);
    expect(await close(pluginIds[0], 'ticket-1')).toMatchObject({ ok: true });
    await waitFor(async () => {
      const observed = await runs();
      expect(observed.length).toBeLessThanOrEqual(2);
      if (observed.length !== 2) return false;
      const sessions = await Promise.all(observed.map(run => readWorkflowChildSession({
        execute: (actionId, input) => actor.executeAsPerson(actionId, input),
        serverBaseUrl: fixture!.server.baseUrl, token: actor.credentials.token,
        runId: run.id, blockId: 'review',
      })));
      return sessions.every(session => session !== null);
    }, { failFast: true, context: 'Only the qualified ticket starts its before and after review Runs' });
    expect(await close(pluginIds[0], 'another-ticket')).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(2);
    const readerContext = { externalActionTarget: { kind: 'machine' as const,
      machineId: readerMachine.target.machineId,
      project: { machineId: readerMachine.target.machineId, directory: readerMachine.workspaceDir } } };
    expect(await reader.executeAsPerson('action.invoke', { action: { pluginId: pluginIds[0], localId: 'close-ticket' },
      input: { ticket: { ticketId: 'ticket-1' } } }, readerContext)).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(2);
    expect(await reader.executeAsPerson('workflow.trigger.list', { subject: {
      kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' },
    } })).toMatchObject({ ok: true, result: { attached: [], skippedNotSharedCount: 0 } });

    const catalogResult = await actor.executeAsPerson('workflow.events.list', machine.target);
    expect(catalogResult.ok, JSON.stringify(catalogResult)).toBe(true);
    if (!catalogResult.ok) throw new Error(`Ticket Event catalog refused (${catalogResult.errorCode})`);
    const selected = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse(
      WorkflowEventsListOutputV1Schema.parse(catalogResult.result).events.find(row =>
        row.event.identity.pluginId === pluginIds[0] && row.event.identity.localId === 'ticket-changed'));
    if (!selected.observationBinding) throw new Error('Ticket Event has no watcher assignment');
    const eventAttachment = await actor.executeAsPerson('workflow.trigger.add', {
      workflow: workflowId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: selected.event.identity,
        sourceInstanceId: 'tickets', sourceContractVersion: 1, sourceConfig: { ticketId: 'ticket-1' },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: selected.observationBinding.materializationRef },
        filter: null, maximumObservationAgeMs: null,
        subject: { kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket',
          identity: { ticketId: 'ticket-1' } } },
    }, context);
    expect(eventAttachment.ok, JSON.stringify(eventAttachment)).toBe(true);
    if (!eventAttachment.ok) throw new Error(`Ticket Event attachment refused (${eventAttachment.errorCode})`);
    const eventSaved = WorkflowTriggerWriteResultV1Schema.parse(eventAttachment.result);
    if (!automationIds.includes(eventSaved.set.automationId)) automationIds.push(eventSaved.set.automationId);
    const observe = (pluginId: string, ticketId: string) => actor.executeAsPerson('action.invoke', {
      action: { pluginId, localId: 'observe-ticket' }, input: { ticketId },
    }, context);
    expect(await observe(pluginIds[1], 'ticket-1')).toMatchObject({ ok: true });
    expect(await observe(pluginIds[0], 'another-ticket')).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(2);
    expect(await observe(pluginIds[0], 'ticket-1')).toMatchObject({ ok: true });
    await waitFor(async () => {
      const observed = await runs();
      expect(observed.length).toBeLessThanOrEqual(3);
      if (observed.length !== 3) return false;
      const sessions = await Promise.all(observed.map(run => readWorkflowChildSession({
        execute: (actionId, input) => actor.executeAsPerson(actionId, input),
        serverBaseUrl: fixture!.server.baseUrl, token: actor.credentials.token,
        runId: run.id, blockId: 'review',
      })));
      return sessions.every(session => session !== null);
    }, { failFast: true, context: 'The declared Event subject selects only its qualified ticket' });
    expect(await reader.executeAsPerson('action.invoke', { action: { pluginId: pluginIds[0], localId: 'observe-ticket' },
      input: { ticketId: 'ticket-1' } }, readerContext)).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(3);
    expect(await reader.executeAsPerson('workflow.trigger.list', { subject: {
      kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' },
    } })).toMatchObject({ ok: true, result: { attached: [], skippedNotSharedCount: 0 } });

    const otherHomeDir = join(testDir, 'other-home');
    await mkdir(otherHomeDir, { recursive: true });
    otherHome = await startTeamSetupFFixture({ testDir: otherHomeDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    expect(otherHome.serverId).not.toBe(fixture.serverId);
    const otherActor = await otherHome.createAccount('other-home-ticket-owner');
    const otherMachine = await otherHome.enrollDaemon(otherActor, {
      env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    });
    const installed = { daemonPort: otherMachine.daemon.state.httpPort,
      controlToken: otherMachine.daemon.state.controlToken,
      pluginRoot: join(testDir, pluginIds[0]), pluginId: pluginIds[0] };
    await applyTrustedLocalPluginFixture({ ...installed, interactionId: 'other-home-ticket-install' });
    await reloadTrustedLocalPluginFixture({ ...installed, changedPaths: ['daemon.mjs'] });
    const otherContext = { externalActionTarget: { kind: 'machine' as const,
      machineId: otherMachine.target.machineId,
      project: { machineId: otherMachine.target.machineId, directory: otherMachine.workspaceDir } } };
    expect(await otherActor.executeAsPerson('action.invoke', {
      action: { pluginId: pluginIds[0], localId: 'close-ticket' },
      input: { ticket: { ticketId: 'ticket-1' } },
    }, otherContext)).toMatchObject({ ok: true });
    expect(await otherActor.executeAsPerson('action.invoke', {
      action: { pluginId: pluginIds[0], localId: 'observe-ticket' }, input: { ticketId: 'ticket-1' },
    }, otherContext)).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(3);
  }, 0);
});
