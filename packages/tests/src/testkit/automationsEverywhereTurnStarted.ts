import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import type { TeamSetupFFixture } from './teamSetupF';
import { fetchJson } from './http';
import { waitFor } from './timing';

/** Real human input → native accepted turn → one immutable lifecycle cause. */
export async function assertAcceptedTurnStartLifecycle(
  fixture: TeamSetupFFixture,
  actor: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>,
  machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>,
) {
  const opened = await actor.execute('projects.open', { ...machine.target,
    source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } },
  { presentUserConfirmation: { actionId: 'projects.open' } });
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  if (!opened.ok) throw new Error(`Turn-start Project refused (${opened.errorCode})`);
  const project = OpenProjectResultV1Schema.parse(opened.result);
  if (project.kind !== 'opened' || !project.facts?.projectKey) throw new Error('Turn-start Project identity absent');
  const projectKey = project.facts.projectKey;
  const source = await fixture.assertKnownGoodSessionControl(actor, machine);
  const headers = { Authorization: `Bearer ${actor.credentials.token}`,
    ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
  await waitFor(async () => {
    const response = await fetchJson<unknown>(`${fixture.server.baseUrl}/v2/sessions/${encodeURIComponent(source.sessionId)}`, { headers });
    expect(response.status).toBe(200);
    return V2SessionByIdResponseSchema.parse(response.data).session.projectKey === projectKey;
  }, { context: 'The source Session publishes the accepted Project before turn-start authoring' });
  expect(source.metadata.machineId).toBe(machine.target.machineId);
  const linked = await actor.execute('workflow.trigger.add', {
    name: 'Observe an accepted turn start',
    target: { kind: 'inline', definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the accepted turn.', references: [], attachments: [] },
        input: [], result: { kind: 'text' } }],
    } },
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'sessionLifecycle', enabled: true,
      subject: { kind: 'project', serverId: fixture.serverId, projectKey },
      events: ['parentTurnStarted'], policy: { kind: 'everyMatch' } },
  });
  expect(linked.ok, JSON.stringify(linked)).toBe(true);
  if (!linked.ok) throw new Error(`Turn-start trigger refused (${linked.errorCode})`);
  const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
  const readRuns = async () => {
    const response = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, { headers });
    expect(response.status).toBe(200);
    return AutomationV3RunListResponseSchema.parse(response.data).runs;
  };
  const message = { sessionId: source.sessionId, message: 'lsl 1 1000 1000', localId: randomUUID() };
  expect(await readRuns()).toEqual([]);
  expect(await actor.execute('session.message.send', message)).toMatchObject({ ok: true });
  await waitFor(async () => {
    const runs = await readRuns();
    expect(runs.length).toBeLessThanOrEqual(1);
    return runs.length === 1;
  }, { failFast: true, context: 'One accepted main turn starts one Workflow Run' });
  const runs = await readRuns();
  const cause = runs[0]!.cause;
  expect(cause).toMatchObject({ kind: 'trigger', triggerId: saved.triggerId, triggerKind: 'sessionLifecycle',
    evidence: { event: 'parentTurnStarted', sourceSessionId: source.sessionId, policy: { kind: 'everyMatch' } } });
  if (cause?.kind !== 'trigger' || cause.triggerKind !== 'sessionLifecycle' || !('sourceTurnId' in cause.evidence)) {
    throw new Error('Turn-start Run did not retain its exact source turn');
  }
  const sourceTurnId = cause.evidence.sourceTurnId;
  const turnResponse = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/sessions/${encodeURIComponent(source.sessionId)}/turns`, { headers });
  expect(turnResponse.status).toBe(200);
  const turn = SessionTurnsProjectionV1Schema.parse(turnResponse.data).turns
    .find(candidate => candidate.turnId === sourceTurnId);
  expect(turn).toMatchObject({ status: 'in_progress', initiator: 'user' });
  expect(await actor.execute('session.message.send', message)).toMatchObject({ ok: true });
  const mutation: SessionTurnMutationV1 = { v: 1, action: 'begin', sessionId: source.sessionId,
    turnId: sourceTurnId, mutationId: randomUUID(), observedAt: Date.now(), initiator: 'user' };
  const mutate = async (body: SessionTurnMutationV1) => {
    const result = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/sessions/${encodeURIComponent(source.sessionId)}/turns/mutations`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(result.status).toBe(200);
    return result.data;
  };
  expect(await mutate(mutation)).toMatchObject({ success: true, applied: true });
  expect(await mutate(mutation)).toMatchObject({ success: true, applied: false });
  expect(await mutate({ v: 1, sessionId: source.sessionId, turnId: sourceTurnId,
    action: 'touch_active', mutationId: randomUUID(), observedAt: Date.now() + 1 }))
    .toMatchObject({ success: true, applied: true });
  expect(await readRuns()).toHaveLength(1);
}
