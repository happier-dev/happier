import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, AutomationActionAdmitRequestV1Schema, AutomationActionAdmitResultV1Schema } from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { WorkflowRunListResultV1Schema, WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { AutomationDefinitionDetailSchema, buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';

import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { findActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { assertAutomationStatusPublicationEconomy } from '../../src/testkit/automationStatusPublicationEconomy';

describe('Automations everywhere: selected attached summaries', () => {
  let fixture: TeamSetupFFixture | undefined;
  let savedCheckEndpoint: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    try { await fixture?.stop(); } finally {
      fixture = undefined;
      const endpoint = savedCheckEndpoint;
      savedCheckEndpoint = undefined;
      if (endpoint) await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    }
  }, 0);

  it('P01.F4 direct-share selected summaries and status economy', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'automations-p01-f4-attached-'));
    const censusPath = join(testDir, 'automation-status-publication.jsonl');
    fixture = await startTeamSetupFFixture({ testDir, automationStatusCensusPath: censusPath,
      dbProvider: 'postgres', observeActionRequests: true, observeSavedHealthSourceSelections: true, serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const owner = await fixture.createAccount('author');
    const reader = await fixture.createAccount('reader');
    // The selected Account read has no Machine prerequisite. Keep this first so
    // a missing read contract is visible before the daemon-backed legs below.
    const emptySelection = await reader.execute('workflow.trigger.list', {
      subject: { kind: 'machine', serverId: fixture.serverId, machineId: randomUUID() }, limit: 1,
    });
    expect(emptySelection.ok, JSON.stringify(emptySelection)).toBe(true);
    if (!emptySelection.ok) throw new Error(`Selected summaries refused (${emptySelection.errorCode})`);
    expect(WorkflowTriggerListResultV1Schema.parse(emptySelection.result)).toMatchObject({
      sets: [], attached: [], nextCursor: null, skippedNotSharedCount: 0,
    });
    const machine = await fixture.enrollDaemon(owner, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' } });
    await fixture.assertKnownGoodSessionControl(owner, machine);
    await assertAutomationStatusPublicationEconomy({ fixture, owner, machine, censusPath });
    const ownerId = readAccountIdFromToken(owner.credentials.token);
    const readerId = readAccountIdFromToken(reader.credentials.token);
    // New resource grants admit friends or teammates. These fresh Accounts
    // establish that relationship through the same person Actions as the app.
    for (const [account, id] of [[owner, ownerId], [reader, readerId]] as const) {
      const username = `f4${id.replaceAll('-', '').slice(0, 12)}`;
      const named = await account.executeAsPerson('account.username.set', { username });
      expect(named, JSON.stringify(named)).toMatchObject({ ok: true, result: { username } });
    }
    const requested = await owner.executeAsPerson('friends.add', { uid: readerId });
    expect(requested, JSON.stringify(requested)).toMatchObject({
      ok: true, result: { user: { id: readerId, status: 'requested' } },
    });
    const accepted = await reader.executeAsPerson('friends.add', { uid: ownerId });
    expect(accepted, JSON.stringify(accepted)).toMatchObject({
      ok: true, result: { user: { id: ownerId, status: 'friend' } },
    });
    const subject = { kind: 'machine', serverId: fixture.serverId, machineId: machine.target.machineId };
    const machineGrant = await owner.executeAsPerson('machines.access.grant.set', { ...machine.target,
      principal: { kind: 'account', accountId: readerId }, level: 'view' });
    expect(machineGrant, JSON.stringify(machineGrant)).toMatchObject({
      ok: true, result: { kind: 'saved' },
    });
    const privateTitle = 'Never disclose this private workflow title';
    const privateInstruction = 'Private author instruction, never a summary field';
    const visible: string[] = [];
    const sharedWorkflows: string[] = [];
    const hidden: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const workflowId = randomUUID();
      expect(await owner.execute('workflow.definition.create', { definitionId: workflowId,
        metadata: { title: index < 3 ? `Shared check ${index}` : privateTitle },
        definition: { version: 1,
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ kind: 'step', id: 'check', document: { text: privateInstruction,
            references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
        } })).toMatchObject({ ok: true });
      const linked = await owner.executeReviewed('workflow.trigger.add', { workflow: workflowId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        trigger: { kind: 'action', enabled: index !== 1, phase: 'after', actionIds: ['machines.command.run'],
          ...(index === 5 ? {} : { subject }) } });
      expect(linked.ok, JSON.stringify(linked)).toBe(true);
      if (!linked.ok) throw new Error(`Selected trigger creation refused (${linked.errorCode})`);
      const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
      if (index === 0) {
        const storedResponse = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${saved.set.automationId}`, {
          headers: { Authorization: `Bearer ${owner.credentials.token}`,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
        });
        expect(storedResponse.status).toBe(200);
        const stored = AutomationDefinitionDetailSchema.parse(storedResponse.data);
        const trigger = stored.triggers.find(row => row.id === saved.triggerId);
        expect(trigger?.kind).toBe('action');
        if (trigger?.kind !== 'action' || 'consentFor' in trigger) throw new Error('Authored Action trigger unavailable');
        expect({ workflowDefinitionId: stored.workflowDefinitionId, reachesOthers: trigger.reachesOthers,
          subjectKind: trigger.subjectKind, subjectKey: trigger.subjectKey }).toEqual({
          workflowDefinitionId: workflowId, reachesOthers: true, subjectKind: subject.kind,
          subjectKey: automationSubjectKeyV1(subject),
        });
      }
      if (index < 3) {
        const workflowGrant = await owner.executeAsPerson('artifact.access.grants.set', { artifactId: workflowId,
          principal: { kind: 'account', accountId: readerId }, accessLevel: 'view' });
        expect(workflowGrant, JSON.stringify(workflowGrant)).toMatchObject({
          ok: true, result: { artifactId: workflowId, changed: true },
        });
        // Existing Artifact read prepares the real E2EE recipient envelope.
        expect(await owner.execute('workflow.definition.get', { definitionId: workflowId })).toMatchObject({ ok: true });
        visible.push(saved.triggerId!);
        sharedWorkflows.push(workflowId);
      } else hidden.push(workflowId);
    }
    fixture.takeRequestObservations();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const selected = await reader.execute('workflow.trigger.list', { subject, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(selected.ok, JSON.stringify(selected)).toBe(true);
      if (!selected.ok) throw new Error(`Selected summaries refused (${selected.errorCode})`);
      const page = WorkflowTriggerListResultV1Schema.parse(selected.result);
      expect(page).toMatchObject({ sets: [], skippedNotSharedCount: 2,
        attached: [expect.objectContaining({ relation: 'direct', setUpBy: expect.objectContaining({ accountId: ownerId }) })] });
      const serialized = JSON.stringify(page);
      expect(serialized).not.toContain(privateTitle);
      expect(serialized).not.toContain(privateInstruction);
      for (const id of hidden) expect(serialized).not.toContain(id);
      for (const row of page.attached ?? []) seen.add(row.triggerId);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect([...seen].sort()).toEqual(visible.slice().sort());
    const contextual = await reader.execute('workflow.trigger.list', {
      subject: { ...subject, serverId: randomUUID() }, contextSubjects: [subject],
    });
    expect(contextual.ok, JSON.stringify(contextual)).toBe(true);
    if (!contextual.ok) throw new Error(`Context summaries refused (${contextual.errorCode})`);
    const contextPage = WorkflowTriggerListResultV1Schema.parse(contextual.result);
    expect(contextPage.skippedNotSharedCount).toBe(2);
    expect(contextPage.attached?.map(row => row.triggerId).sort()).toEqual(visible.slice().sort());
    expect(contextPage.attached?.every(row => row.relation === 'context')).toBe(true);
    const own = await owner.execute('workflow.trigger.list', { subject });
    expect(own.ok, JSON.stringify(own)).toBe(true);
    if (!own.ok) throw new Error(`Owned summaries refused (${own.errorCode})`);
    const ownPage = WorkflowTriggerListResultV1Schema.parse(own.result);
    expect(ownPage.sets).toEqual([]);
    expect(ownPage.attached?.filter(row => row.relation === 'direct')).toHaveLength(5);
    // Machine selection has no implicit Account-wide Action context (P01 R8).
    expect(ownPage.attached?.filter(row => row.relation === 'context')).toHaveLength(0);
    expect(ownPage.skippedNotSharedCount).toBe(0);
    // The same local Machine id on another Home is a different subject.
    expect(await reader.execute('workflow.trigger.list', {
      subject: { ...subject, serverId: randomUUID() }, limit: 1,
    })).toMatchObject({ ok: true, result: { sets: [], attached: [], skippedNotSharedCount: 0, nextCursor: null } });
    // A direct person grant, without a Team audience, must join the source
    // Trigger to the invoking Account's consent and actual Run.
    const actorMachine = await fixture.enrollDaemon(reader, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actorSession = await fixture.assertKnownGoodSessionControl(reader, actorMachine);
    const actorSubject = { kind: 'machine', ...actorMachine.target };
    const actorGrant = await reader.executeAsPerson('machines.access.grant.set', { ...actorMachine.target,
      principal: { kind: 'account', accountId: ownerId }, level: 'admin' });
    expect(actorGrant, JSON.stringify(actorGrant)).toMatchObject({ ok: true, result: { kind: 'saved' } });
    const directWorkflowId = randomUUID();
    expect(await owner.executeAsPerson('workflow.definition.create', { definitionId: directWorkflowId,
      metadata: { title: 'Direct person command check' }, definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: {
          text: 'Check this command and finish successfully.', references: [], attachments: [] } }],
      } })).toMatchObject({ ok: true });
    const directWorkflowGrant = await owner.executeAsPerson('artifact.access.grants.set', { artifactId: directWorkflowId,
      principal: { kind: 'account', accountId: readerId }, accessLevel: 'view' });
    expect(directWorkflowGrant, JSON.stringify(directWorkflowGrant)).toMatchObject({
      ok: true, result: { changed: true },
    });
    expect(await owner.execute('workflow.definition.get', { definitionId: directWorkflowId })).toMatchObject({ ok: true });
    const directTriggers = [];
    for (const enabled of [true, false]) {
      const added = await owner.executeAsPerson('workflow.trigger.add', { workflow: directWorkflowId,
        project: { machineId: actorMachine.target.machineId, directory: actorMachine.workspaceDir },
        trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask', enabled,
          actionIds: ['machines.command.run'], subject: actorSubject } });
      expect(added.ok, JSON.stringify(added)).toBe(true);
      if (!added.ok) throw new Error(added.errorCode);
      const saved = WorkflowTriggerWriteResultV1Schema.parse(added.result);
      if (!saved.triggerId) throw new Error('Direct-person source Trigger missing');
      directTriggers.push({ automationId: saved.set.automationId, triggerId: saved.triggerId });
    }
    const [directSource, offSibling] = directTriggers;
    if (!directSource || !offSibling) throw new Error('Direct-person source pair missing');
    expect(offSibling.automationId).toBe(directSource.automationId);
    fixture.takeRequestObservations();
    const beforeConsent = await reader.execute('workflow.trigger.list', { subject: actorSubject });
    expect(beforeConsent.ok, JSON.stringify(beforeConsent)).toBe(true);
    if (!beforeConsent.ok) throw new Error(beforeConsent.errorCode);
    expect(WorkflowTriggerListResultV1Schema.parse(beforeConsent.result).attached?.map(row => row.triggerId).sort())
      .toEqual(directTriggers.map(row => row.triggerId).sort());
    const invoked = await reader.execute('machines.command.run', {
      command: process.platform === 'win32' ? 'echo checked' : 'printf checked',
    }, { defaultSessionId: actorSession.sessionId, presentUserConfirmation: { actionId: 'machines.command.run' },
      externalActionTarget: { kind: 'machine', machineId: actorMachine.target.machineId,
        project: { machineId: actorMachine.target.machineId, directory: actorMachine.workspaceDir } } });
    expect(invoked.ok, JSON.stringify(invoked)).toBe(true);
    if (!invoked.ok) throw new Error(invoked.errorCode);
    const approval = ActionApprovalRequestCreatedResultSchema.parse(invoked.result);
    const readDirectApproval = async (artifactId = approval.artifactId) => {
      const result = await reader.execute('approval.request.get', { artifactId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(result.result).request;
    };
    expect(await readDirectApproval()).toMatchObject({ status: 'open', automaticChecks: { phase: 'consent',
      consents: [expect.objectContaining(directSource)] } });
    expect(await reader.executeAsPerson('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve',
      triggerConsent: { ...directSource, decision: 'allow' } })).toMatchObject({ ok: true });
    await waitFor(async () => (await readDirectApproval()).status === 'executed',
      { context: 'Direct-person consent check and original command settle', failFast: true });
    expect(await readDirectApproval()).toMatchObject({ execution: { ok: true } });
    const consentIndex = await fetchJson<unknown>(`${fixture.server.baseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, {
      headers: { Authorization: `Bearer ${reader.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
    });
    expect(consentIndex.status).toBe(200);
    const actorConsents = ActionAutomationIndexV1Schema.parse(consentIndex.data).rows.filter(row =>
      row.consentFor?.automationId === directSource.automationId && row.consentFor.triggerId === directSource.triggerId);
    expect(actorConsents).toHaveLength(1);
    const actorConsent = actorConsents[0];
    if (!actorConsent) throw new Error('Direct-person Allow did not persist actor consent');
    expect(actorConsent.ownerAccountId).toBe(readerId);
    expect(actorConsent.automationId).not.toBe(directSource.automationId);
    expect(actorConsent.triggerId).not.toBe(directSource.triggerId);
    const actorRunsResult = await reader.execute('workflow.run.list', { sourceArtifactId: directWorkflowId, starter: 'current_account' });
    expect(actorRunsResult.ok, JSON.stringify(actorRunsResult)).toBe(true);
    if (!actorRunsResult.ok) throw new Error(actorRunsResult.errorCode);
    const actorRuns = WorkflowRunListResultV1Schema.parse(actorRunsResult.result).runs;
    expect(actorRuns).toHaveLength(1);
    const actorRun = actorRuns[0];
    if (!actorRun) throw new Error('Direct-person actor Run missing');
    expect(actorRun.origin).toMatchObject({ kind: 'automation', automationId: actorConsent.automationId,
      cause: { kind: 'trigger', triggerId: actorConsent.triggerId, triggerKind: 'action' } });
    const detail = await reader.execute('workflow.run.get', { runId: actorRun.id });
    expect(detail.ok, JSON.stringify(detail)).toBe(true);
    if (!detail.ok) throw new Error(detail.errorCode);
    expect(WorkflowRunGetResultV1Schema.parse(detail.result).acceptedContext.machineId).toBe(actorMachine.target.machineId);
    const afterConsent = await reader.execute('workflow.trigger.list', { subject: actorSubject });
    expect(afterConsent.ok, JSON.stringify(afterConsent)).toBe(true);
    if (!afterConsent.ok) throw new Error(afterConsent.errorCode);
    const directPage = WorkflowTriggerListResultV1Schema.parse(afterConsent.result);
    expect(directPage.attached?.find(row => row.triggerId === directSource.triggerId))
      .toMatchObject({ automationId: directSource.automationId, lastRun: { id: actorRun.id } });
    // Siblings share an Automation. Its latest Run cannot stand in for each Trigger.
    const offSummary = directPage.attached?.find(row => row.triggerId === offSibling.triggerId);
    expect(offSummary).toMatchObject({ automationId: offSibling.automationId, enabled: false });
    expect(offSummary?.lastRun?.id).not.toBe(actorRun.id);
    // Pausing an actor consent removes it from the enabled index. A later person
    // Allow creates a new consent identity; resuming the old one leaves two
    // persisted references to the same source Trigger, without a uniqueness rule.
    const actorHeaders = { Authorization: `Bearer ${reader.credentials.token}`,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
    const paused = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${actorConsent.automationId}/pause`, {
      method: 'POST', headers: actorHeaders,
    });
    expect(paused.status).toBe(200);
    expect(AutomationDefinitionDetailSchema.parse(paused.data).enabled).toBe(false);
    expect(await reader.execute('workflow.trigger.list', { subject: actorSubject })).toMatchObject({ ok: true,
      result: { attached: expect.arrayContaining([expect.objectContaining({ triggerId: directSource.triggerId,
        lastRun: expect.objectContaining({ id: actorRun.id }) })]) } });
    // A new real UI client reads the paused index through ordinary composition.
    const renewed = await reader.executeAsPerson('machines.command.run', {
      command: process.platform === 'win32' ? 'echo checked again' : 'printf checked-again',
    }, { defaultSessionId: actorSession.sessionId, presentUserConfirmation: { actionId: 'machines.command.run' },
      externalActionTarget: { kind: 'machine', machineId: actorMachine.target.machineId,
        project: { machineId: actorMachine.target.machineId, directory: actorMachine.workspaceDir } } });
    expect(renewed.ok, JSON.stringify(renewed)).toBe(true);
    if (!renewed.ok) throw new Error(renewed.errorCode);
    const renewedApproval = ActionApprovalRequestCreatedResultSchema.parse(renewed.result);
    expect(await readDirectApproval(renewedApproval.artifactId)).toMatchObject({ automaticChecks: { phase: 'consent' } });
    expect(await reader.executeAsPerson('approval.request.decide', { artifactId: renewedApproval.artifactId, decision: 'approve',
      triggerConsent: { ...directSource, decision: 'allow' } })).toMatchObject({ ok: true });
    await waitFor(async () => (await readDirectApproval(renewedApproval.artifactId)).status === 'executed',
      { context: 'Second direct-person consent check settles', failFast: true });
    expect(await readDirectApproval(renewedApproval.artifactId)).toMatchObject({ execution: { ok: true } });
    const renewedIndex = await fetchJson<unknown>(`${fixture.server.baseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, { headers: actorHeaders });
    expect(renewedIndex.status).toBe(200);
    const renewedConsent = ActionAutomationIndexV1Schema.parse(renewedIndex.data).rows.find(row =>
      row.consentFor?.automationId === directSource.automationId && row.consentFor.triggerId === directSource.triggerId);
    if (!renewedConsent) throw new Error('Renewed person Allow did not persist actor consent');
    expect(renewedConsent.triggerId).not.toBe(actorConsent.triggerId);
    const renewedRunsResult = await reader.execute('workflow.run.list', { sourceArtifactId: directWorkflowId, starter: 'current_account' });
    expect(renewedRunsResult.ok, JSON.stringify(renewedRunsResult)).toBe(true);
    if (!renewedRunsResult.ok) throw new Error(renewedRunsResult.errorCode);
    const renewedRun = WorkflowRunListResultV1Schema.parse(renewedRunsResult.result).runs.find(run => run.id !== actorRun.id);
    if (!renewedRun) throw new Error('Renewed actor consent did not start an actual Run');
    expect(renewedRun.origin).toMatchObject({ kind: 'automation', automationId: renewedConsent.automationId,
      cause: { kind: 'trigger', triggerId: renewedConsent.triggerId, triggerKind: 'action' } });
    const resumed = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${actorConsent.automationId}/resume`, {
      method: 'POST', headers: actorHeaders,
    });
    expect(resumed.status).toBe(200);
    expect(AutomationDefinitionDetailSchema.parse(resumed.data).enabled).toBe(true);
    const multipleIndex = await fetchJson<unknown>(`${fixture.server.baseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, { headers: actorHeaders });
    expect(multipleIndex.status).toBe(200);
    const activeActorConsents = ActionAutomationIndexV1Schema.parse(multipleIndex.data).rows.filter(row =>
      row.consentFor?.automationId === directSource.automationId && row.consentFor.triggerId === directSource.triggerId);
    expect(activeActorConsents.map(row => row.triggerId).sort()).toEqual([actorConsent.triggerId, renewedConsent.triggerId].sort());
    const resumedConsent = activeActorConsents.find(row => row.triggerId === actorConsent.triggerId);
    if (!resumedConsent) throw new Error('Resumed actor consent missing');
    expect(await reader.execute('workflow.trigger.list', { subject: actorSubject })).toMatchObject({ ok: true,
      result: { attached: expect.arrayContaining([expect.objectContaining({ triggerId: directSource.triggerId,
        lastRun: expect.objectContaining({ id: renewedRun.id }) })]) } });
    // Admit an occurrence using the older still-enabled canonical consent. The
    // source card must now follow this actual Run, rather than a chosen alias.
    const olderReferenceRun = await fetchJson<unknown>(`${fixture.server.baseUrl}${AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1}`, {
      method: 'POST', headers: { ...actorHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(AutomationActionAdmitRequestV1Schema.parse({
        triggers: [{ automationId: resumedConsent.automationId, triggerId: resumedConsent.triggerId,
          triggerRevision: resumedConsent.triggerRevision }],
        evidence: { v: 1, kind: 'action', actionId: 'machines.command.run', requestId: randomUUID(), phase: 'before',
          occurredAt: Date.now(), machineId: actorMachine.target.machineId, subjects: [] },
      })),
    });
    expect(olderReferenceRun.status).toBe(200);
    const olderOccurrence = AutomationActionAdmitResultV1Schema.parse(olderReferenceRun.data).results[0];
    if (!olderOccurrence || olderOccurrence.kind === 'skipped') throw new Error('Older admitted consent occurrence missing');
    await waitFor(async () => {
      const result = await reader.execute('workflow.run.get', { runId: olderOccurrence.runId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return WorkflowRunGetResultV1Schema.parse(result.result).run.state === 'succeeded';
    }, { context: 'Older consent reference actually executes its new Run', failFast: true });
    expect(await reader.execute('workflow.trigger.list', { subject: actorSubject })).toMatchObject({ ok: true,
      result: { attached: expect.arrayContaining([expect.objectContaining({ triggerId: directSource.triggerId,
        lastRun: expect.objectContaining({ id: olderOccurrence.runId }) })]) } });
    expect(await owner.execute('workflow.run.get', { runId: actorRun.id })).toMatchObject({ ok: false, errorCode: 'run_not_found' });
    expect(await owner.executeAsPerson('artifact.access.grants.remove', { artifactId: directWorkflowId,
      principal: { kind: 'account', accountId: readerId } })).toMatchObject({ ok: true });
    expect(await reader.execute('workflow.trigger.list', { subject: actorSubject }))
      .toMatchObject({ ok: true, result: { attached: [], skippedNotSharedCount: 2 } });
    expect(await reader.execute('workflow.run.get', { runId: actorRun.id })).toMatchObject({ ok: true });
    fixture.takeRequestObservations();
    const healthCatalog = await owner.execute('workflow.events.list', machine.target);
    expect(healthCatalog.ok, JSON.stringify(healthCatalog)).toBe(true);
    if (!healthCatalog.ok) throw new Error(healthCatalog.errorCode);
    const healthEvent = WorkflowEventsListOutputV1Schema.parse(healthCatalog.result).events.find(row =>
      row.event.identity.pluginId === HEALTH_CHECK_EVENT_REFS_V1.failed.pluginId
      && row.event.identity.localId === HEALTH_CHECK_EVENT_REFS_V1.failed.localId);
    if (!healthEvent?.observationBinding) throw new Error('Saved health observer unavailable');
    const healthMaterialization = healthEvent.observationBinding.materializationRef;
    savedCheckEndpoint = createServer((_request, response) => { response.writeHead(200); response.end('ok'); });
    await new Promise<void>(resolve => savedCheckEndpoint!.listen(0, '127.0.0.1', resolve));
    const healthAddress = savedCheckEndpoint.address();
    if (!healthAddress || typeof healthAddress === 'string') throw new Error('Health boundary unavailable');
    const secretHealthEndpoint = `http://127.0.0.1:${healthAddress.port}/private?access_token=never-disclose`;
    const healthSubjects = ['web', 'api'].map(serviceId => ({ kind: 'machineService' as const,
      machineId: machine.target.machineId, serviceId }));
    const healthSources = healthSubjects.map(createHealthCheckSourceInstanceIdV1);
    const addHealthSource = async (index: number, enabled: boolean) => {
      const healthSaved = await owner.execute('workflow.trigger.add', {
        observationOnly: { kind: 'observationOnly' }, name: 'Private saved health source',
        trigger: { kind: 'pluginEvent', enabled,
          eventRef: HEALTH_CHECK_EVENT_REFS_V1.failed, displayLabel: 'Saved check',
          sourceInstanceId: healthSources[index], sourceContractVersion: 1,
          sourceConfig: { v: 1, subject: healthSubjects[index],
            checks: ['ready', 'healthy'].map(checkId => ({ checkId,
              kind: { pluginId: HEALTH_CHECK_EVENT_REFS_V1.failed.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
              config: { endpoint: secretHealthEndpoint, expectStatus: 200 },
              periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 })) },
          observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: healthMaterialization },
          filter: null, maximumObservationAgeMs: null },
      });
      expect(healthSaved.ok, JSON.stringify(healthSaved)).toBe(true);
      if (!healthSaved.ok) throw new Error(healthSaved.errorCode);
      const healthWritten = WorkflowTriggerWriteResultV1Schema.parse(healthSaved.result);
      if (!healthWritten.triggerId) throw new Error('Saved health trigger missing');
      return { automationId: healthWritten.set.automationId, triggerId: healthWritten.triggerId };
    };
    const healthSourceRefs = [await addHealthSource(0, false), await addHealthSource(1, false)];
    // Same encrypted source in distinct Trigger rows: newer Off alias must not beat
    // the enabled observer, or repeat checks on the next public source page.
    const preferredHealthSource = await addHealthSource(0, true);
    await addHealthSource(0, false);
    fixture.takeRequestObservations();
    const subjectsSpec = findActionSpec('workflow.subjects.list');
    expect(subjectsSpec, 'Saved-check selector must be an ordinary Account Action').toBeDefined();
    if (!subjectsSpec?.outputSchema) throw new Error('Saved-check selector Action unavailable');
    const healthSelection = await owner.execute(subjectsSpec.id, {
      kind: 'healthCheck', sources: [healthSourceRefs[0]], limit: 1,
    });
    expect(healthSelection.ok, JSON.stringify(healthSelection)).toBe(true);
    if (!healthSelection.ok) throw new Error(`Saved-check selection refused (${healthSelection.errorCode})`);
    subjectsSpec.outputSchema.parse(healthSelection.result);
    expect(healthSelection.result).toMatchObject({ nextCursor: null, subjects: ['ready', 'healthy'].map(checkId => ({
      subject: { kind: 'healthCheck', serverId: fixture.serverId, sourceInstanceId: healthSources[0], checkId },
      source: healthSourceRefs[0],
    })) });
    const healthSelectedReads = fixture.takeRequestObservations();
    const healthSourceQueries = healthSelectedReads.filter(row => row.definitionSourceSelection);
    expect(healthSourceQueries.length).toBeGreaterThan(0);
    for (const query of healthSourceQueries) {
      expect(query.definitionSourceSelection).toEqual({ sources: [healthSourceRefs[0]], returnedTriggerIds: [healthSourceRefs[0]!.triggerId] });
    }
    // The enabled observer may publish unrelated background health/checkpoint facts.
    // This read must not create, reconcile or remove an Automation/source definition.
    expect(healthSelectedReads.filter(row => row.path.startsWith('/v3/automations') && row.method !== 'GET'
      && !(row.method === 'POST' && row.path === '/v3/automations/query'))).toEqual([]);
    const healthSerialized = JSON.stringify(healthSelection.result);
    expect(healthSerialized).not.toContain(secretHealthEndpoint);
    expect(healthSerialized).not.toContain('access_token');
    expect(healthSerialized).not.toContain(healthSources[1]);
    expect(healthSerialized).not.toContain('sourceConfig');
    const otherHealthSelection = await reader.execute(subjectsSpec.id, { kind: 'healthCheck' });
    expect(otherHealthSelection).toMatchObject({ ok: true, result: { subjects: [] } });
    const discoveredHealthPages: unknown[] = [];
    let healthCursor: string | undefined;
    do {
      const discovered = await owner.execute(subjectsSpec.id, { kind: 'healthCheck', limit: 1,
        ...(healthCursor ? { cursor: healthCursor } : {}) });
      expect(discovered.ok, JSON.stringify(discovered)).toBe(true);
      if (!discovered.ok) throw new Error(discovered.errorCode);
      const healthPage: unknown = subjectsSpec.outputSchema.parse(discovered.result);
      discoveredHealthPages.push(healthPage);
      // The declared output schema owns the page. This narrow transport check permits
      // the RED test to load before the new Action/output producer is present.
      if (!healthPage || typeof healthPage !== 'object' || !('nextCursor' in healthPage)) throw new Error('Missing subject continuation');
      const nextCursor = healthPage.nextCursor;
      if (nextCursor !== null && typeof nextCursor !== 'string') throw new Error('Invalid subject continuation');
      healthCursor = nextCursor ?? undefined;
    } while (healthCursor);
    // Limit counts canonical saved sources after global priority/dedup; one source
    // contains two check subjects. It is intentionally not a check-row limit.
    expect(discoveredHealthPages).toHaveLength(2);
    expect(discoveredHealthPages).toEqual(expect.arrayContaining(healthSources.map((sourceInstanceId, index) =>
      expect.objectContaining({ subjects: ['ready', 'healthy'].map(checkId => expect.objectContaining({
        subject: expect.objectContaining({ kind: 'healthCheck', serverId: fixture.serverId, sourceInstanceId, checkId }),
        source: index === 0 ? preferredHealthSource : healthSourceRefs[1],
      })) }))));
    // Withdrawal changes discovery at the next read; it never exposes the old row.
    expect(await owner.execute('artifact.access.grants.remove', { artifactId: sharedWorkflows[0],
      principal: { kind: 'account', accountId: readerId } })).toMatchObject({ ok: true });
    const afterWithdrawal = await reader.execute('workflow.trigger.list', { subject });
    expect(afterWithdrawal.ok, JSON.stringify(afterWithdrawal)).toBe(true);
    if (!afterWithdrawal.ok) throw new Error(`Selected summaries refused (${afterWithdrawal.errorCode})`);
    const remaining = WorkflowTriggerListResultV1Schema.parse(afterWithdrawal.result);
    expect(remaining.skippedNotSharedCount).toBe(3);
    expect(remaining.attached?.map(row => row.triggerId).sort()).toEqual(visible.slice(1).sort());
    expect(JSON.stringify(remaining)).not.toContain(sharedWorkflows[0]);
    const outsider = await fixture.createAccount('private-trigger-outsider');
    expect(await outsider.execute('workflow.trigger.list', { subject })).toMatchObject({
      ok: true, result: { attached: [], skippedNotSharedCount: 0 },
    });
    expect(await reader.execute('workflow.trigger.list', { actionId: 'machines.command.run', phase: 'after' }))
      .toMatchObject({ ok: true, result: { skippedNotSharedCount: 0 } });
    expect(await owner.execute('machines.access.grant.remove', { ...machine.target,
      principal: { kind: 'account', accountId: readerId } })).toMatchObject({ ok: true });
    const afterMachineWithdrawal = await reader.execute('workflow.trigger.list', { subject });
    expect(afterMachineWithdrawal).toMatchObject({ ok: true, result: { skippedNotSharedCount: 0 } });
    if (!afterMachineWithdrawal.ok) throw new Error(afterMachineWithdrawal.errorCode);
    expect(WorkflowTriggerListResultV1Schema.parse(afterMachineWithdrawal.result).attached?.map(row => row.triggerId).sort())
      .toEqual(visible.slice(1).sort());
    // Selected reads must never request the Account's body-bearing inventory.
    expect(fixture.takeRequestObservations().filter(row => row.method === 'GET' && row.path === '/v3/automations')).toEqual([]);
  }, 0);
});
