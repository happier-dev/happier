import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { AxiosError } from 'axios';
import { afterEach, expect, it, vi } from 'vitest';

import axios from '@/api/client/credentialAxios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { createActionAutomationPrivateMatchingV1 } from '@happier-dev/protocol/actions/executor/actionAutomationPrivateMatching';
import { readAccountStoredActionTriggerV1 } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { applyCliActionAutomationUpdateV1, createCliActionAutomationPortV1 as createCheckedPort,
  readCliHasAfterActionAutomationsV1,
  refreshCliActionAutomationsFromChangesV1 } from './actionAutomations';

afterEach(() => vi.restoreAllMocks());

function createCliActionAutomationPortV1(input: Omit<Parameters<typeof createCheckedPort>[0], 'checks'>,
  prepareMatching = createActionAutomationPrivateMatchingV1({ accountId: 'owner',
    readDefinition: async () => null, openTrigger: async () => { throw new Error('No private rows served'); },
  })) {
  return createCheckedPort({ ...input, checks: { prepareMatching,
    resolveConsent: async () => ({ current: false }),
    allowConsent: async () => { throw new Error('No shared rows served'); },
  } });
}

function serveHomeFeatures(workflowsEnabled: boolean) {
  const features = FeaturesResponseSchema.parse({ features: { workflows: { enabled: workflowsEnabled } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
}

it('skips selection and native completion demand for an Action on a Workflows-disabled Home', async () => {
  serveHomeFeatures(false);
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
  const port = createCliActionAutomationPortV1({ token, serverHttpBaseUrl: 'https://workflows-disabled.test' });
  if (!port?.hasAfterActions) throw new Error('Expected the Account Action port');
  const args = { actionId: 'machines.command.run', input: {}, context: { defaultSessionMachineId: 'invoking-machine' } };
  expect(await port.select(args)).toMatchObject({ status: 'ready', before: [], after: [], notices: [] });
  expect(await readCliHasAfterActionAutomationsV1({ token, serverHttpBaseUrl: 'https://workflows-disabled.test' }, [args.actionId]))
    .toBe(false);
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { status: null, reason: 'server_unreachable' },
  { status: 503, reason: 'database_connection_unavailable' },
  { status: 404, reason: 'not_found' },
])('reports an enabled Home index failure as $reason', async ({ status, reason }) => {
  serveHomeFeatures(true);
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const request = vi.spyOn(axios, 'request');
  if (status === null) request.mockRejectedValue(new AxiosError('Connection refused', 'ECONNREFUSED'));
  else request.mockResolvedValue({ status, data: { error: reason } });
  const port = createCliActionAutomationPortV1({ token, serverHttpBaseUrl: `https://index-failure-${reason}.test` });
  if (!port) throw new Error('Expected the Account Action port');
  expect(await port.select({ actionId: 'machines.command.run', input: {}, context: {} })).toMatchObject({
    before: [], after: [], notices: [{ code: 'action_automations_not_checked', reason }],
  });
});

it.each([
  { featuresStatus: 'network', indexReason: 'server_unreachable' },
  { featuresStatus: 429, indexReason: 'database_connection_unavailable' },
  { featuresStatus: 503, indexReason: 'database_connection_unavailable' },
  { featuresStatus: 'invalid_payload', indexReason: 'database_connection_unavailable' },
] as const)('runs the Action with an index notice when the feature read returns $featuresStatus', async ({ featuresStatus, indexReason }) => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (featuresStatus === 'network') throw new TypeError('Failed to fetch');
    if (featuresStatus === 'invalid_payload') return Response.json('invalid features payload');
    return new Response(null, { status: featuresStatus });
  });
  const request = vi.spyOn(axios, 'request');
  if (indexReason === 'server_unreachable') request.mockRejectedValue(new AxiosError('Connection refused', 'ECONNREFUSED'));
  else request.mockResolvedValue({ status: 503, data: { error: indexReason } });
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const serverHttpBaseUrl = `https://unknown-features-${featuresStatus}.test`;
  const port = createCliActionAutomationPortV1({ token, serverHttpBaseUrl });
  if (!port) throw new Error('Expected the Account Action port');
  const profile = { name: 'Updated', firstName: 'Updated', lastName: null, timestamp: 1 };
  const executor = createActionExecutor({ actionAutomations: port, homeDomainAction: async () => profile });
  const result = await executor.execute('account.name.set', { name: profile.name }, {
    surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner',
    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'account.name.set': ['cli'] } }),
  });
  expect(result).toEqual({
    ok: true, result: profile, automationNotices: [{ code: 'action_automations_not_checked', reason: indexReason }],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    method: 'GET', url: `${serverHttpBaseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`,
  }));
});

it('keeps retained Action consumers on the same Account index when another credential for that Account is bound', async () => {
  serveHomeFeatures(true);
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

it('keeps the Account index usable after the creator’s Session checks are collected', async () => {
  serveHomeFeatures(false);
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const home = { token, serverHttpBaseUrl: 'https://disposable-index-creator.test' };
  const createSession = () => {
    const checks = {
      prepareMatching: createActionAutomationPrivateMatchingV1({ accountId: 'owner',
        readDefinition: async () => null, openTrigger: async () => { throw new Error('No private rows served'); },
      }),
      resolveConsent: async () => ({ current: false as const }),
      allowConsent: async () => { throw new Error('No shared rows served'); },
    };
    createCheckedPort({ ...home, checks });
    return new WeakRef(checks);
  };
  const checks = createSession();
  // Vitest's fork does not expose GC. Enable it in an isolated VM for this observation.
  setFlagsFromString('--expose-gc');
  const collect: () => void = (() => {
    try { return runInNewContext('gc'); }
    finally { setFlagsFromString('--no-expose-gc'); }
  })();
  await setImmediate();
  collect();
  collect();
  expect(checks.deref()).toBeUndefined();
  expect(await readCliHasAfterActionAutomationsV1(home, ['machines.command.run'])).toBe(false);
});

it('keeps each caller credential at the HTTP boundary while sharing ready selections and cursor updates', async () => {
  serveHomeFeatures(true);
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
  serveHomeFeatures(true);
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
    isCredentialCurrent: async () => { if (pause) await new Promise<void>(resolve => { release = resolve; }); return true; } }, prepareMatching);
  if (!original) throw new Error('Original Account port unavailable');
  const selection = await original.select({ actionId: 'machines.command.run', input: {},
    context: { defaultSessionMachineId: 'invoking-machine' } });
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
