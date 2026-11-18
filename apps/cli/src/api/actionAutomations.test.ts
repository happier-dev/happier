import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import axios from '@/api/client/credentialAxios';
import { createActionAutomationPrivateMatchingV1 } from '@happier-dev/protocol/actions/executor/actionAutomationPrivateMatching';
import { readAccountStoredActionTriggerV1 } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { applyCliActionAutomationUpdateV1, createCliActionAutomationPortV1,
  refreshCliActionAutomationsFromChangesV1 } from './actionAutomations';

afterEach(() => vi.restoreAllMocks());

it('keeps retained Action consumers on the same Account index when another credential for that Account is bound', async () => {
  const accountId = randomUUID();
  const token = (device: string) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, device })).toString('base64url')}.signature`;
  const originalToken = token('original');
  const otherToken = token('other');
  const serverHttpBaseUrl = 'https://action-index.test';
  const row = { automationId: 'automation', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow',
    workflowRevision: 1, ownerAccountId: accountId, actionIds: ['machines.command.run'],
    phase: 'before', mode: 'wait', onFailure: 'refuse' };
  // HTTP is the boundary; the shared index, selector and retained consumers stay real.
  const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { v: 1, rows: [row] } });
  const original = createCliActionAutomationPortV1({ token: originalToken, serverHttpBaseUrl });
  expect(original).toBeDefined();
  if (!original) throw new Error('Original Account port unavailable');
  const args = { actionId: 'machines.command.run', input: { command: 'echo control' },
    context: { defaultSessionMachineId: 'invoking-machine' } };
  expect((await original.select(args)).before).toMatchObject([row]);
  const other = createCliActionAutomationPortV1({ token: otherToken, serverHttpBaseUrl });
  expect(other).toBeDefined();
  if (!other) throw new Error('Second Account port unavailable');
  expect((await other.select(args)).before).toMatchObject([row]);
  const updated = { ...row, triggerRevision: 2 };
  applyCliActionAutomationUpdateV1({ token: otherToken, serverHttpBaseUrl,
    body: { t: 'automation-upsert', actionIndex: { automationId: row.automationId, rows: [updated] } } });
  expect(await original.select(args)).toMatchObject({ status: 'ready', before: [updated], notices: [] });
  expect(await other.select(args)).toMatchObject({ status: 'ready', before: [updated], notices: [] });
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps each caller credential at the HTTP boundary while sharing ready selections and cursor updates', async () => {
  const accountId = randomUUID();
  const token = (device: string) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, device })).toString('base64url')}.signature`;
  const originalToken = token('original');
  const otherToken = token('other');
  const serverHttpBaseUrl = 'https://action-index.test';
  const sent: string[] = [];
  const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
    sent.push(String(config.headers?.Authorization));
    return { status: 200, data: config.url?.endsWith('/admit') ? { results: [] } : { v: 1, rows: [] } };
  });
  let originalCurrent = true;
  let releaseCredential: (() => void) | undefined;
  let blockCredential = false;
  const original = createCliActionAutomationPortV1({ token: originalToken, serverHttpBaseUrl,
    isCredentialCurrent: async () => {
      if (blockCredential) await new Promise<void>(resolve => { releaseCredential = resolve; });
      return originalCurrent;
    } });
  const other = createCliActionAutomationPortV1({ token: otherToken, serverHttpBaseUrl });
  if (!original?.admitOccurrence || !other?.admitOccurrence) throw new Error('Account occurrence transport unavailable');
  const args = { actionId: 'machines.command.run', input: {}, context: { defaultSessionMachineId: 'invoking-machine' } };
  await original.select(args);
  const occurrence = { triggers: [], evidence: { v: 1 as const, kind: 'action' as const,
    actionId: 'machines.command.run', requestId: 'request', phase: 'before' as const, occurredAt: 1, subjects: [] } };
  blockCredential = true;
  const pending = original.admitOccurrence(occurrence, {});
  expect(releaseCredential).toBeDefined();
  await other.admitOccurrence(occurrence, {});
  releaseCredential?.();
  await pending;
  expect(sent).toEqual([`Bearer ${originalToken}`, `Bearer ${otherToken}`, `Bearer ${originalToken}`]);
  blockCredential = false;
  originalCurrent = false;
  // Ready local selection is not a new permission check; the existing HTTP owner checks currentness.
  expect(await original.select(args)).toMatchObject({ status: 'ready' });
  await expect(original.admitOccurrence(occurrence, {})).rejects.toMatchObject({ code: 'action_account_scope_changed' });
  expect(request).toHaveBeenCalledTimes(3);
  await refreshCliActionAutomationsFromChangesV1({ token: otherToken, serverHttpBaseUrl,
    changes: [{ kind: 'automation', entityId: 'automation' }] });
  expect(sent.at(-1)).toBe(`Bearer ${otherToken}`);
});

it('settles an admitted after check with its originating caller credential after another caller binds', async () => {
  const accountId = randomUUID();
  const token = (device: string) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, device })).toString('base64url')}.signature`;
  const originalToken = token('original');
  const otherToken = token('other');
  const serverHttpBaseUrl = 'https://action-index.test';
  const row = { automationId: 'automation', triggerId: 'after', triggerRevision: 1, workflowId: randomUUID(),
    workflowRevision: 1, ownerAccountId: accountId, actionIds: ['machines.command.run'], phase: 'after' };
  const definition = AutomationDefinitionDetailSchema.parse({ id: row.automationId, name: 'After', description: null,
    enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, workflowDefinitionId: row.workflowId,
    templateCiphertext: 'retained-workflow-template', scopeSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
    triggers: [{ id: row.triggerId, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
      kind: 'action', phase: 'after', actionIds: row.actionIds,
      triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, automationId: row.automationId, triggerId: row.triggerId, triggerRevision: 1, triggerKind: 'action' },
        definition: { kind: 'action', phase: 'after', actionIds: row.actionIds } })) }] });
  const sent: string[] = [];
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    if (config.url?.endsWith('/definition')) return { status: 200, data: definition };
    if (config.url?.endsWith('/admit')) {
      sent.push(String(config.headers?.Authorization));
      return { status: 200, data: { results: [] } };
    }
    return { status: 200, data: { v: 1, rows: [row] } };
  });
  const prepareMatching = createActionAutomationPrivateMatchingV1({ accountId,
    readDefinition: async () => AutomationDefinitionDetailSchema.parse((await axios.request({ url: `${serverHttpBaseUrl}/definition` })).data),
    openTrigger: async (stored, trigger) => readAccountStoredActionTriggerV1(stored, trigger.id,
      { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }).definition });
  let pause = false;
  let release: (() => void) | undefined;
  const original = createCliActionAutomationPortV1({ token: originalToken, serverHttpBaseUrl,
    isCredentialCurrent: async () => { if (pause) await new Promise<void>(resolve => { release = resolve; }); return true; } });
  if (!original) throw new Error('Original Account port unavailable');
  const selection = await original.select({ actionId: 'machines.command.run', input: {},
    context: { defaultSessionMachineId: 'invoking-machine' }, prepareMatching });
  pause = true;
  const pending = original.settle({ selection, context: {}, event: { v: 1, kind: 'action', actionId: 'machines.command.run',
    requestId: 'settled-request', phase: 'after', status: 'succeeded', occurredAt: 1, subjects: [] } });
  // Matching is real and asynchronous; wait until settlement reaches its credential boundary.
  await vi.waitFor(() => expect(release).toBeDefined());
  const other = createCliActionAutomationPortV1({ token: otherToken, serverHttpBaseUrl });
  if (!other?.admitOccurrence) throw new Error('Second Account occurrence transport unavailable');
  await other.admitOccurrence({ triggers: [], evidence: { v: 1, kind: 'action', actionId: 'machines.command.run',
    requestId: 'other-request', phase: 'before', occurredAt: 1, subjects: [] } }, {});
  release?.();
  await pending;
  expect(sent).toEqual([`Bearer ${otherToken}`, `Bearer ${originalToken}`]);
});
