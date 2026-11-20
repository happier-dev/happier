import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionSpecGetResultSchema } from '@happier-dev/protocol/actions/specs/catalog';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { applyTrustedLocalPluginFixture, reloadTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { readWorkflowChildSession, waitForWorkflowChildSession } from '../../src/testkit/workflowChildSession';
import { installExternalTicketAutomationFixture } from '../../src/testkit/pluginPlatform/externalTicketAutomationFixture';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { connectUiPersonActionClient, mountUiAutomationSubjectPicker, mountUiWorkflowActionCatalog } from '@happier-tests/ui-action-client';
import { captureActiveServerAccountScopeLifetime } from '../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope';
import { acquireDaemonMergedWorkflowActionCatalog, loadDaemonMergedProjectionCacheEntry } from '../../../../apps/ui/sources/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { listWorkflowStepActionSpecs } from '../../../../apps/ui/sources/components/workflows/presentation/workflowActionCatalog';

function expectAction(result: ActionExecuteResult) {
  return expect(result, JSON.stringify(result.ok ? { ok: true } : { ok: false,
    errorCode: result.errorCode, failureCause: result.failureCause }));
}

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
        const discovery = await catalog.promise;
        const specs = listWorkflowStepActionSpecs(inputs.pluginProjectionV2, inputs.pluginUiProjection,
          undefined, discovery, 'after');
        const actionId = formatQualifiedPluginActionId({ pluginId: pluginIds[0], localId: 'close-ticket' });
        const contributionKey = buildQualifiedPluginContributionKey({ pluginId: pluginIds[0], localId: 'close-ticket' });
        const projectAction = (action: typeof inputs.pluginUiProjection.actionsById[string] | undefined) => action ? {
          pluginId: action.pluginId, id: action.id,
          available: action.available, readOnly: action.readOnly, dangerLevel: action.dangerLevel,
          surfaces: action.surfaces, target: action.execution.target,
          approvalScope: action.approvalScope,
        } : null;
        const rawAction = inputs.pluginProjectionV2?.actionsById[contributionKey];
        const uiAction = inputs.pluginUiProjection.actionsById[contributionKey];
        const discoveredAction = discovery.find(action => action.id === actionId);
        const selectedSpec = specs.find(spec => spec.id === actionId);
        if (!selectedSpec) {
          // Capture the failed consumer first; this subsequent diagnostic read
          // must never supply or refresh the entry being asserted below.
          console.log('F7_PICKER_PROJECTION_BEFORE_DIRECT_READ', JSON.stringify({
            generation: inputs.pluginProjectionV2?.generation,
            rawAction: projectAction(rawAction), uiAction: projectAction(uiAction),
          }));
          try {
            const fresh = await actor.execute('action.spec.get', {
              id: actionId, includeOutputSchema: false,
            }, context);
            const directAction = fresh.ok ? ActionSpecGetResultSchema.parse(fresh.result).actionSpec : null;
            console.log('F7_PICKER_DIRECT_MACHINE_ACTION_SPEC', JSON.stringify(fresh.ok ? {
              ok: true, action: directAction ? { id: directAction.id,
                automation: directAction.automation, approvalScope: directAction.approvalScope } : null,
            } : { ok: false, errorCode: fresh.errorCode }));
          } catch (error) {
            console.log('F7_PICKER_DIRECT_MACHINE_ACTION_SPEC', JSON.stringify({
              threw: error instanceof Error ? error.name : 'unknown',
            }));
          }
        }
        expect(selectedSpec, JSON.stringify({
          rawAction: projectAction(rawAction), uiAction: projectAction(uiAction),
          discovery: discoveredAction ? { automation: discoveredAction.automation,
            approvalScope: discoveredAction.approvalScope } : null,
          subjectKinds: Object.values(inputs.pluginUiProjection.subjectKindsById)
            .filter(kind => kind.pluginId === pluginIds[0]).length,
        }))
          .toMatchObject({ subjectKind: { ok: true, subjectKind: {
            kind: 'plugin', pluginId: pluginIds[0], subjectKindId: 'ticket', definition: { listAction: 'list-tickets' },
          } } });
      } finally { catalog.release(); }
      const subjectPicker = await mountUiAutomationSubjectPicker({
        kind: { kind: 'plugin', pluginId: pluginIds[0], subjectKindId: 'ticket' },
        page: { limit: 20 }, subjectKinds: Object.values(inputs.pluginUiProjection.subjectKindsById),
        machineId: machine.target.machineId,
      });
      try {
        await subjectPicker.waitForSettled();
        const page = subjectPicker.read();
        expect(page).toMatchObject({ status: 'ready', items: expect.arrayContaining([{ label: 'Fix the checkout', subject: {
          kind: 'plugin', serverId: pickerClient.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket',
          identity: { ticketId: 'ticket-1' },
        } }]), hasMore: false, coverage: 'complete' });
        const selected = page.items.find(item => item.label === 'Fix the checkout')?.subject;
        if (!selected) throw new Error('Ticket picker selection unavailable');
        selectedTicket = selected;
      } finally { await subjectPicker.close(); }
    } finally { await pickerClient.close(); }
    const workflowId = randomUUID();
    const definitionCreated = await actor.executeAsPerson('workflow.definition.create', { definitionId: workflowId,
      metadata: { title: 'Shared ticket review' }, definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the ticket.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } });
    expect(definitionCreated.ok, JSON.stringify({ ok: definitionCreated.ok,
      ...(!definitionCreated.ok ? { errorCode: definitionCreated.errorCode } : {}) })).toBe(true);
    const ownerId = readAccountIdFromToken(actor.credentials.token);
    const readerId = readAccountIdFromToken(reader.credentials.token);
    // The public sharing owner admits friends or teammates as new recipients.
    for (const [account, id] of [[actor, ownerId], [reader, readerId]] as const) {
      expectAction(await account.executeAsPerson('account.username.set', {
        username: `f7${id.replaceAll('-', '').slice(0, 12)}`,
      })).toMatchObject({ ok: true });
    }
    expectAction(await actor.executeAsPerson('friends.add', { uid: readerId })).toMatchObject({
      ok: true, result: { user: { id: readerId, status: 'requested' } },
    });
    expectAction(await reader.executeAsPerson('friends.add', { uid: ownerId })).toMatchObject({
      ok: true, result: { user: { id: ownerId, status: 'friend' } },
    });
    expectAction(await actor.executeAsPerson('artifact.access.grants.set', { artifactId: workflowId,
      principal: { kind: 'account', accountId: readerId }, accessLevel: 'view' }))
      .toMatchObject({ ok: true });
    // The shared Workflow is real; sharing it must not create a grant owner for plugin identities.
    expectAction(await actor.executeAsPerson('workflow.definition.get', { definitionId: workflowId })).toMatchObject({ ok: true });
    const { saved, beforeSaved } = await (async () => {
      const editorClient = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl,
        addressAnchorUrl: fixture!.server.baseUrl, accountSecret: actor.auth.accountSigningSeed });
      const catalogs: Awaited<ReturnType<typeof mountUiWorkflowActionCatalog>>[] = [];
      try {
        // ActionTrackRows keeps both native catalogs mounted throughout Save.
        for (const phase of ['before', 'after'] as const) {
          const catalog = await mountUiWorkflowActionCatalog({ serverId: editorClient.serverId,
            machineId: machine.target.machineId, phase });
          catalogs.push(catalog);
          await catalog.waitForSettled();
          expect(catalog.read().phase).toBe('ready');
          expect(catalog.read().specs.map(spec => spec.id)).toEqual(expect.arrayContaining(
            pluginIds.map(pluginId => formatQualifiedPluginActionId({ pluginId, localId: 'close-ticket' }))));
        }
        const linked = await editorClient.executeConfirmed('workflow.trigger.add', {
          workflow: workflowId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
          trigger: { kind: 'action', phase: 'after', enabled: true,
            actionIds: pluginIds.map(pluginId => formatQualifiedPluginActionId({ pluginId, localId: 'close-ticket' })),
            subject: selectedTicket },
        }, { ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: editorClient.serverId, serverIdentityId: fixture!.serverId, actionRequestId: randomUUID() });
        expect(linked.ok, JSON.stringify(linked)).toBe(true);
        if (!linked.ok) throw new Error(`Ticket attachment refused (${linked.errorCode})`);
        const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
        expect(saved.set.triggers).toContainEqual(expect.objectContaining({ subject: {
          kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' },
        } }));
        const before = await editorClient.executeConfirmed('workflow.trigger.add', {
          workflow: workflowId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
          trigger: { kind: 'action', phase: 'before', mode: 'notify', enabled: true,
            actionIds: pluginIds.map(pluginId => formatQualifiedPluginActionId({ pluginId, localId: 'close-ticket' })),
            subject: { kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' } } },
        }, { ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: editorClient.serverId, serverIdentityId: fixture!.serverId, actionRequestId: randomUUID() });
        expect(before.ok, JSON.stringify(before)).toBe(true);
        if (!before.ok) throw new Error(`Before-ticket attachment refused (${before.errorCode})`);
        const beforeSaved = WorkflowTriggerWriteResultV1Schema.parse(before.result);
        return { saved, beforeSaved };
      } finally {
        for (const catalog of catalogs.reverse()) await catalog.close();
        await editorClient.close();
      }
    })();
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
    const waitForReviewSessions = async (expectedCount: number, reason: string) => {
      // One mounted App owns the Account lifetime for these concurrent reads.
      const runReader = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl,
        addressAnchorUrl: fixture!.server.baseUrl, accountSecret: actor.auth.accountSigningSeed });
      try {
        await waitForWorkflowChildSession(async () => {
          const observed = await runs();
          expect(observed.length).toBeLessThanOrEqual(expectedCount);
          if (observed.length !== expectedCount) return false;
          const sessions = await Promise.all(observed.map(run => readWorkflowChildSession({
            execute: (actionId, input) => runReader.executeConfirmed(actionId, input, {
              surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
              serverId: runReader.serverId, serverIdentityId: fixture!.serverId, actionRequestId: randomUUID(),
            }),
            serverBaseUrl: fixture!.server.baseUrl, token: actor.credentials.token,
            runId: run.id, blockId: 'review',
          })));
          return sessions.every(session => session !== null);
        }, reason);
      } finally { await runReader.close(); }
    };
    const close = (pluginId: string, ticketId: string) => actor.executeAsPerson('action.invoke', {
      action: { pluginId, localId: 'close-ticket' }, input: { ticket: { ticketId } },
    }, context, { action: { pluginId, localId: 'close-ticket' }, machineId: machine.target.machineId });
    expectAction(await close(pluginIds[1], 'ticket-1')).toMatchObject({ ok: true });
    expectAction(await close(pluginIds[0], 'another-ticket')).toMatchObject({ ok: true });
    expect(await runs()).toEqual([]);
    expectAction(await close(pluginIds[0], 'ticket-1')).toMatchObject({ ok: true });
    await waitForReviewSessions(2, 'Only the qualified ticket starts its before and after review Runs');
    expectAction(await close(pluginIds[0], 'another-ticket')).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(2);
    const readerContext = { externalActionTarget: { kind: 'machine' as const,
      machineId: readerMachine.target.machineId,
      project: { machineId: readerMachine.target.machineId, directory: readerMachine.workspaceDir } } };
    expectAction(await reader.executeAsPerson('action.invoke', { action: { pluginId: pluginIds[0], localId: 'close-ticket' },
      input: { ticket: { ticketId: 'ticket-1' } } }, readerContext,
      { action: { pluginId: pluginIds[0], localId: 'close-ticket' }, machineId: readerMachine.target.machineId }))
      .toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(2);
    expectAction(await reader.executeAsPerson('workflow.trigger.list', { subject: {
      kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0], subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' },
    } })).toMatchObject({ ok: true, result: { attached: [], skippedNotSharedCount: 0 } });

    const catalogResult = await actor.executeAsPerson('workflow.events.list', machine.target);
    expect(catalogResult.ok, JSON.stringify(catalogResult)).toBe(true);
    if (!catalogResult.ok) throw new Error(`Ticket Event catalog refused (${catalogResult.errorCode})`);
    const selected = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse(
      WorkflowEventsListOutputV1Schema.parse(catalogResult.result).events.find(row =>
        row.event.identity.pluginId === pluginIds[0] && row.event.identity.localId === 'ticket-changed'));
    if (!selected.observationBinding) throw new Error('Ticket Event has no watcher assignment');
    const configured = await actor.executeAsPerson('action.invoke', {
      action: { pluginId: pluginIds[0], localId: 'watch-tickets' }, input: { ticketId: 'ticket-1' },
    }, context, { action: { pluginId: pluginIds[0], localId: 'watch-tickets' }, machineId: machine.target.machineId });
    expect(configured.ok, JSON.stringify(configured)).toBe(true);
    if (!configured.ok) throw new Error(`Ticket Event setup refused (${configured.errorCode})`);
    const source = PluginEventAutomationSetupResultV1Schema.parse(configured.result);
    const eventAttachment = await actor.executeAsPerson('workflow.trigger.add', {
      workflow: workflowId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: selected.event.identity,
        sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
        sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
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
    }, context, { action: { pluginId, localId: 'observe-ticket' }, machineId: machine.target.machineId });
    expectAction(await observe(pluginIds[1], 'ticket-1')).toMatchObject({ ok: true });
    expectAction(await observe(pluginIds[0], 'another-ticket')).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(2);
    expectAction(await observe(pluginIds[0], 'ticket-1')).toMatchObject({ ok: true });
    await waitForReviewSessions(3, 'The declared Event subject selects only its qualified ticket');
    expectAction(await reader.executeAsPerson('action.invoke', { action: { pluginId: pluginIds[0], localId: 'observe-ticket' },
      input: { ticketId: 'ticket-1' } }, readerContext,
      { action: { pluginId: pluginIds[0], localId: 'observe-ticket' }, machineId: readerMachine.target.machineId }))
      .toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(3);
    expectAction(await reader.executeAsPerson('workflow.trigger.list', { subject: {
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
    expectAction(await otherActor.executeAsPerson('action.invoke', {
      action: { pluginId: pluginIds[0], localId: 'close-ticket' },
      input: { ticket: { ticketId: 'ticket-1' } },
    }, otherContext, { action: { pluginId: pluginIds[0], localId: 'close-ticket' },
      machineId: otherMachine.target.machineId })).toMatchObject({ ok: true });
    expectAction(await otherActor.executeAsPerson('action.invoke', {
      action: { pluginId: pluginIds[0], localId: 'observe-ticket' }, input: { ticketId: 'ticket-1' },
    }, otherContext, { action: { pluginId: pluginIds[0], localId: 'observe-ticket' },
      machineId: otherMachine.target.machineId })).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(3);
  }, 0);
});
