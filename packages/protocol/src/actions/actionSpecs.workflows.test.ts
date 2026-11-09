import { expect, it } from 'vitest';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec, listVoiceToolActionSpecs } from './actionSpecs.js';

it('opens boundary Resume content for automation while keeping person controls key-free', () => {
  const input = { mode: 'boundary', runId: '11111111-1111-4111-8111-111111111111', expectedRevision: 2 };
  const demand = getActionSpec('workflow.run.resume').requesterAccountContentDemandForInput!;
  expect(demand(input, { surface: 'ui', authority: 'present_user' })).toBe(false);
  expect(demand(input, { surface: 'agent', authority: 'account_automation' })).toBe(true);
  expect(doesExternalActionConsumeRequesterAccountContentV1({ actionId: 'workflow.run.resume', input })).toBe(true);
  expect(demand({ mode: 'recover', runId: input.runId, expectedRevision: 2 }, { surface: 'ui', authority: 'present_user' })).toBe(true);
});

it('projects every workflow start through Voice with the ordinary start approval and strict input', () => {
  const spec = getActionSpec('workflow.run.start');
  expect(listVoiceToolActionSpecs().find(candidate => candidate.id === spec.id)).toBe(spec);
  expect(spec.bindings?.voiceClientToolName).toBe('workflow_run_start');
  expect(spec.safety).toBe('safe');
  expect(spec.approval).toEqual({ result: 'optional', flow: 'deferred' });
  expect(spec.inputSchema.safeParse(JSON.parse(spec.examples!.voice!.argsExample!)).success).toBe(true);
});

it('admits a safe failure acknowledgement only with the observed failure identity', () => {
  const spec = getActionSpec('workflow.run.read_state.set');
  expect(spec.safety).toBe('safe');
  const observed = { runId: '11111111-1111-4111-8111-111111111111', revision: 2,
    failedAt: '2026-10-23T10:00:00.000Z' };
  expect(spec.inputSchema.safeParse(observed).success).toBe(true);
  expect(spec.inputSchema.safeParse({ runId: observed.runId, revision: 2 }).success).toBe(false);
  expect(spec.inputSchema.safeParse({ ...observed, ownerAccountId: 'caller-claimed-owner' }).success).toBe(false);
});

it('elicits each revision in the owner’s format rather than confusing definition, Run and invocation revisions', () => {
  for (const id of ['workflow.definition.update', 'workflow.definition.edit'] as const) {
    expect(getActionSpec(id).inputHints?.fields.find(field => field.path === 'expectedRevision'))
      .toMatchObject({ widget: 'json', required: true });
  }
  expect(getActionSpec('workflow.run.pause').inputHints?.fields.find(field => field.path === 'expectedRevision'))
    .toMatchObject({ widget: 'number', required: true });
  expect(getActionSpec('workflow.run.invocations.publish_draft').inputHints?.fields.find(field => field.path === 'expectedContentRevision'))
    .toMatchObject({ widget: 'text', required: true });
});
