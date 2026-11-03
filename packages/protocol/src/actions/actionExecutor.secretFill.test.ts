import { describe, expect, it } from 'vitest';

import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';
import { isRuntimeActionExecutorReal } from './surfaces.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createApprovalRequestArtifact } from '../approvals/creation.js';
import { approvalArtifactBodyMatchesHeaderV1 } from '../approvals/approvalArtifactHeaderV1.js';
import type { ActionDefinitionV1 } from './actionDefinitionV1.js';

const request = {
  serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
  browserSessionId: 'browser', viewId: 'view', tabId: 'tab', frameId: 'frame',
  documentId: 'document', navigationGeneration: 1, origin: 'https://example.test',
  field: { fieldId: 'password', focusId: 'focus', locator: '#password' },
} as const;
const context = { surface: 'agent', authority: 'account_automation', serverId: 'home',
  defaultSessionId: 'session', defaultSessionMachineId: 'machine', actionRequestId: 'request',
  actionCaller: { kind: 'host' } } as const;

function harness(overrides: Partial<ActionExecutorDeps> = {}) {
  const records = new Map<string, ApprovalRequest>();
  let rawEffects = 0;
  // The Artifact port is a storage boundary. The executor and all admission/schema logic remain real.
  const executor = createActionExecutor({
    approvalsCreate: async ({ request }) => { records.set('approval', request); return { artifactId: 'approval' }; },
    approvalsGet: async ({ artifactId }) => records.get(artifactId) ?? null,
    approvalsUpdate: async ({ artifactId, request }) => { records.set(artifactId, request); return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
    isActionApprovalRequired: () => false,
    runtimeActionExecute: async () => { rawEffects += 1; return { status: 'filled', code: 'filled' }; },
    ...overrides,
  } as ActionExecutorDeps);
  return { executor, records, rawEffects: () => rawEffects };
}

const privateInput = { v: 1, artifactId: 'approval', requestId: 'request', actionId: 'browser.automation.secret.fill',
  request, accountEncryptionMode: 'plain', choice: { kind: 'once', value: 'RECOGNIZABLE-D26-CREDENTIAL' }, submit: false } as const;

const credentialDefinition: ActionDefinitionV1 = {
  kindVersion: 1, id: 'com.acme.credentials/actions/connect', title: 'Connect', description: 'Connect service',
  safety: 'safe', placements: [], slash: null, bindings: null, examples: null,
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true, api: false, plugin: true },
  inputHints: { fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }] },
  inputSchema: { type: 'object' },
};

describe('confidential secret-fill approval continuation', () => {
  it.each([undefined, null, { clientId: 'public-client' }])('lets Account-waived MCP sign-in reach its host without an optional client secret (%j)', async client => {
    let effects = 0;
    const { executor, records } = harness({ isActionApprovalRequired: undefined, mcpServerAction: async () => {
      effects++;
      return { ok: true, result: { attemptId: 'attempt', authorizationUrl: 'https://example.test/sign-in', expiresAtMs: 100, machineId: 'machine' } };
    } });
    const input = { serverId: 'mcp-server', ...(client === undefined ? {} : { client }) };
    const result = await executor.execute('mcp.servers.signIn.start', input, { ...context,
      surface: 'ui', authority: 'present_user', actionsSettings: { v: 1, actions: {},
        approvalWaivedSurfaces: { 'mcp.servers.signIn.start': ['ui'] } } });
    expect(result).toMatchObject({ ok: true, result: { attemptId: 'attempt' } });
    expect(records.size).toBe(0);
    expect(effects).toBe(1);
  });

  it('keeps an explicit UI Ask at the approval policy without manufacturing a confidential-input choice', async () => {
    let effects = 0;
    const { executor, records } = harness({ isActionApprovalRequired: undefined,
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request: { ...request, status: 'rejected' } }),
      mcpServerAction: async () => { effects++; return { ok: true, result: {} }; },
    });
    expect(await executor.execute('mcp.servers.signIn.start', { serverId: 'mcp-server' }, { ...context,
      surface: 'ui', authority: 'present_user', actionsSettings: { v: 1, actions: {
        'mcp.servers.signIn.start': { approvalRequiredSurfaces: ['ui'] },
      } } })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(records.size).toBe(1);
    expect(records.get('approval')?.preview).not.toHaveProperty('confidentialInputs');
    expect(effects).toBe(0);
  });

  it('uses the selected plugin declaration for a single multi-field private request', async () => {
    const definition: ActionDefinitionV1 = {
      kindVersion: 1, id: 'com.acme.credentials/actions/connect', title: 'Connect', description: 'Connect service',
      safety: 'safe', placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true, api: false, plugin: true },
      inputHints: { fields: [{ path: 'credentials.token', title: 'Token', widget: 'secret', required: true },
        { path: 'credentials.password', title: 'Password', widget: 'secret', required: true }] },
      inputSchema: { type: 'object' },
    };
    const selections: unknown[] = [];
    let effects = 0;
    let materialCalls = 0;
    const { executor, records } = harness({
      listContributedActionDefinitions: selection => { selections.push(selection); return [definition]; },
      confidentialActionInputs: async ({ continuation, execute }) => {
        materialCalls++;
        return execute({ ...continuation.request,
          input: { credentials: { token: 'private-token', password: 'private-password' } } });
      },
      // Contributed code is outside the protocol process's deterministic domain owner.
      invokeContributedAction: async ({ input, context }) => {
        expect(input).toEqual({ credentials: { token: 'private-token', password: 'private-password' } });
        expect(context.bypassApprovals).toBe(true);
        effects++;
        return { ok: true, result: { connected: true } };
      },
    });
    const input = { action: { pluginId: 'com.acme.credentials', localId: 'connect' }, input: {} };
    expect(await executor.execute('action.invoke', input, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', actionId: 'action.invoke' } });
    expect(effects).toBe(0);
    expect(selections.length).toBeGreaterThan(0);
    for (const selection of selections) expect(selection).toEqual({ id: definition.id });
    expect(records.get('approval')?.preview).toMatchObject({ confidentialInputs: { kind: 'action_inputs',
      paths: ['input.credentials.token', 'input.credentials.password'] } });
    expect(records.get('approval')?.actionArgs).toEqual(input);
    expect(records.get('approval')).toMatchObject({ executionOriginV1: { requestId: 'request', machineId: 'machine' } });
    expect(await executor.continueConfidentialApprovalRequest({ v: 1, kind: 'action_inputs', artifactId: 'approval',
      requestId: 'request', actionId: 'action.invoke', request: input, serverId: 'home', machineId: 'machine',
      accountEncryptionMode: 'plain', choices: [
        { path: 'input.credentials.password', choice: { kind: 'once', value: 'private-password' } },
        { path: 'input.credentials.token', choice: { kind: 'once', value: 'private-token' } },
      ] }, { surface: 'ui', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { connected: true } });
    expect(materialCalls).toBe(1);
    expect(effects).toBe(1);
    expect(records.size).toBe(1);
  });

  it('defers a required secret leaf without admitting unrelated missing or malformed fields', async () => {
    const { executor, records } = harness();
    const input = { serverId: 'home', homeId: 'home', managedId: 'managed', operationId: 'operation',
      taskId: 'task', purpose: 'establish', promptId: 'prompt' };
    const human = { ...context, surface: 'agent', authority: 'present_user' } as const;
    expect(await executor.execute('machines.managed.bootstrap.respond', { ...input, taskId: undefined }, human))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('machines.managed.bootstrap.respond', { ...input, password: 42 }, human))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(records.size).toBe(0);
    expect(await executor.execute('machines.managed.bootstrap.respond', input, human))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(records.get('approval')?.actionArgs).toEqual(input);
  });

  it('keeps supplied confidential siblings out of a deferred request even when their controls are hidden', async () => {
    const definition: ActionDefinitionV1 = {
      kindVersion: 1, id: 'com.acme.credentials/actions/connect', title: 'Connect', description: 'Connect service',
      safety: 'safe', placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true, api: false, plugin: true },
      inputHints: { fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true },
        { path: 'password', title: 'Password', widget: 'secret', visibleWhen: { op: 'truthy', path: 'passwordMode' } }] },
      inputSchema: { type: 'object' },
    };
    const marker = 'PRIVATE-HIDDEN-SIBLING';
    let effects = 0;
    const { executor, records } = harness({ listContributedActionDefinitions: () => [definition],
      confidentialActionInputs: async ({ continuation, execute }) => execute({ ...continuation.request,
        input: { token: 'chosen-token', password: 'chosen-password' } }),
      invokeContributedAction: async ({ input }) => {
        expect(input).toEqual({ token: 'chosen-token', password: 'chosen-password' });
        effects++;
        return { ok: true, result: { connected: true } };
      },
    });
    expect(await executor.execute('action.invoke', {
      action: { pluginId: 'com.acme.credentials', localId: 'connect' }, input: { password: marker },
    }, context)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(JSON.stringify([...records.values()])).not.toContain(marker);
    expect(records.get('approval')?.preview).toMatchObject({ confidentialInputs: {
      paths: ['input.token', 'input.password'],
    } });
    expect(await executor.continueConfidentialApprovalRequest({ v: 1, kind: 'action_inputs', artifactId: 'approval',
      requestId: 'request', actionId: 'action.invoke',
      request: { action: { pluginId: 'com.acme.credentials', localId: 'connect' }, input: {} },
      serverId: 'home', machineId: 'machine', accountEncryptionMode: 'plain', choices: [
        { path: 'input.token', choice: { kind: 'once', value: 'chosen-token' } },
        { path: 'input.password', choice: { kind: 'once', value: 'chosen-password' } },
      ] }, { surface: 'ui', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { connected: true } });
    expect(effects).toBe(1);
  });

  it('delivers a declared Action input once and keeps private operands out of history and observations', async () => {
    const marker = 'CRED-ASK-PRIVATE-INPUT';
    let effects = 0;
    const observations: unknown[] = [];
    const { executor, records } = harness({
      observeActionExecution: async event => { observations.push(event); },
      listContributedActionDefinitions: () => [credentialDefinition],
      // Private material acquisition and contributed code are genuine host boundaries.
      confidentialActionInputs: async ({ continuation, execute }) => {
        expect(continuation.choices).toEqual([{ path: 'input.token', choice: { kind: 'once', value: marker } }]);
        return await execute({ ...continuation.request, input: { token: marker } });
      },
      invokeContributedAction: async ({ input }) => {
        expect(input).toEqual({ token: marker });
        effects++;
        return { ok: true, result: { connected: true } };
      },
    });
    const input = { action: { pluginId: 'com.acme.credentials', localId: 'connect' }, input: {} };
    expect(await executor.execute('action.invoke', input, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created' } });
    const privateChoice = { v: 1, kind: 'action_inputs', artifactId: 'approval', requestId: 'request',
      actionId: 'action.invoke', request: input, serverId: 'home', machineId: 'machine',
      accountEncryptionMode: 'plain', choices: [{ path: 'input.token', choice: { kind: 'once', value: marker } }] };
    const human = { surface: 'ui', authority: 'present_user', serverId: 'home' } as const;
    for (const changed of [
      { ...privateChoice, machineId: 'sibling' }, { ...privateChoice, serverId: 'sibling-home' },
      { ...privateChoice, choices: [] },
      { ...privateChoice, choices: [...privateChoice.choices, ...privateChoice.choices] },
      { ...privateChoice, choices: [{ path: 'serverId', choice: { kind: 'once', value: marker } }] },
      { ...privateChoice, request: { ...input, action: { ...input.action, localId: 'sibling' } } },
    ]) expect(await executor.continueConfidentialApprovalRequest(changed, human)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(effects).toBe(0);
    expect(await executor.continueConfidentialApprovalRequest(privateChoice, human)).toMatchObject({ ok: true });
    expect(await executor.continueConfidentialApprovalRequest(privateChoice, human)).toMatchObject({ ok: true });
    expect(effects).toBe(1);
    expect(JSON.stringify([...records.values()])).not.toContain(marker);
    expect(JSON.stringify(observations)).not.toContain(marker);
  });

  it('defers a declared secret input even when ordinary Action approval is waived', async () => {
    let effects = 0;
    const { executor, records } = harness({ listContributedActionDefinitions: () => [credentialDefinition],
      invokeContributedAction: async () => {
      effects++;
      return { ok: true, result: { connected: true } };
    } });
    const input = { action: { pluginId: 'com.acme.credentials', localId: 'connect' }, input: {} };
    expect(await executor.execute('action.invoke', input, context)).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', actionId: 'action.invoke' },
    });
    expect(effects).toBe(0);
    expect(records.get('approval')?.actionArgs).toEqual(input);
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'confidential_choice_required' });
  });

  it('keeps deferred native fill unavailable at the catalog without approval or daemon dispatch', async () => {
    const { executor, records, rawEffects } = harness();
    const result = await executor.execute('computer.secret.fill', {
      serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
      sourceId: 'source', target: { kind: 'window', displayId: 'display', pid: 1, windowId: 2 },
      captureId: 'capture', geometry: { captureWidth: 100, captureHeight: 100, nativeWidth: 100, nativeHeight: 100,
        originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 100 } },
      field: { fieldId: 'password', focusId: 'focus' },
    }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled',
      details: { available: false, reason: 'unsupported_surface' } });
    expect(resolveActionSurfaceAvailability({ actionId: 'computer.secret.fill', surface: 'plugin' }))
      .toMatchObject({ available: false, reason: 'unsupported_surface', availableSurfaces: [] });
    expect(records.size).toBe(0);
    expect(rawEffects()).toBe(0);
    expect(isRuntimeActionExecutorReal('computer.secret.fill')).toBe(false);
  });

  it('creates one portable-Home browser card through the real creation owner and fills once from another profile', async () => {
    const browserRequest = {
      serverId: 'portable-home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
      browserSessionId: 'browser', viewId: 'view', tabId: 'tab', frameId: 'frame',
      documentId: 'document', navigationGeneration: 1, origin: 'https://example.test',
      field: { fieldId: 'password', focusId: 'focus', locator: '#password' },
    };
    const rows = new Map<string, { header: Record<string, unknown>; body: string; access: string }>();
    let fills = 0;
    let writes = 0;
    const settlementHomes: (string | null | undefined)[] = [];
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }) => createApprovalRequestArtifact({ request, accountId: 'account',
        newId: () => 'unused', read: async id => rows.get(id) ?? null,
        create: async (id, header, body) => { writes++; rows.set(id, { header, body, access: 'owner' }); },
      }),
      approvalsGet: async ({ artifactId }) => {
        const row = rows.get(artifactId);
        const parsed = row && approvalArtifactBodyMatchesHeaderV1(row.header, row.body);
        return parsed?.family === 'built_in' ? parsed.request : null;
      },
      approvalsUpdate: async ({ artifactId, request, serverId }) => {
        settlementHomes.push(serverId);
        const row = rows.get(artifactId);
        if (!row) throw new Error('Missing approval');
        rows.set(artifactId, { ...row, header: { ...row.header, approvalStatus: request.status }, body: JSON.stringify(request) });
        return { ok: true };
      },
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => true,
      confidentialSecretFill: async ({ isCurrent }) => {
        expect(await isCurrent()).toBe(true);
        fills++;
        return { status: 'filled', code: 'filled' };
      },
    });
    const requestingContext = { ...context, serverId: 'creator-profile', serverIdentityId: 'portable-home', runtimeAccountId: 'account' };
    const created = await executor.execute('browser.automation.secret.fill', browserRequest, requestingContext);
    expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await executor.execute('browser.automation.secret.fill', browserRequest, requestingContext)).toEqual(created);
    expect(rows.size).toBe(1);
    expect(writes).toBe(1);
    const [artifactId, row] = [...rows.entries()][0]!;
    expect(JSON.parse(row.body).executionOriginV1).toMatchObject({ serverIdentityId: 'portable-home' });
    const continuation = { ...privateInput, artifactId, actionId: 'browser.automation.secret.fill', request: browserRequest };
    const human = { authority: 'present_user', serverId: 'approver-profile', serverIdentityId: 'portable-home', runtimeAccountId: 'account' } as const;
    expect(await executor.continueConfidentialApprovalRequest(continuation, human))
      .toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(await executor.continueConfidentialApprovalRequest(continuation, human))
      .toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(fills).toBe(1);
    expect(settlementHomes.length).toBeGreaterThan(0);
    expect(settlementHomes.every(home => home === 'portable-home')).toBe(true);
    expect(JSON.stringify([...rows.values()])).not.toContain(privateInput.choice.value);
  });

  it('keeps configured policy admission separate from the required confidential target/value choice', async () => {
    const { executor, records, rawEffects } = harness();
    expect(await executor.execute('browser.automation.secret.fill', request, context)).toEqual({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'approval', actionId: 'browser.automation.secret.fill',
    } });
    expect(rawEffects()).toBe(0);
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'confidential_choice_required' });
    expect(rawEffects()).toBe(0);
  });

  it('accepts an exact human continuation once and stores only bounded settlement', async () => {
    let delivered = 0;
    const { executor, records, rawEffects } = harness({
      confidentialSecretFill: async (args) => {
        expect(await args.isCurrent()).toBe(true);
        expect(args.choice).toEqual(privateInput.choice);
        delivered += 1;
        return { status: 'filled', code: 'filled' };
      },
    });
    await executor.execute('browser.automation.secret.fill', request, context);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(delivered).toBe(0);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(delivered).toBe(1);
    expect(rawEffects()).toBe(0);
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(delivered).toBe(1);
  });

  it('refuses a changed target and never replays an issued uncertain fill or submit', async () => {
    let delivered = 0;
    const { executor, records } = harness({ confidentialSecretFill: async () => {
      delivered += 1;
      throw new Error(privateInput.choice.value);
    } });
    await executor.execute('browser.automation.secret.fill', request, context);
    expect(await executor.continueConfidentialApprovalRequest({ ...privateInput, request: { ...request, documentId: 'new' } },
      { authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(delivered).toBe(0);
    const unknown = await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'present_user', serverId: 'home' });
    expect(unknown).toEqual({ ok: true, result: { status: 'unknown', code: 'delivery_unknown' } });
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'approval', callerAuthority: 'present_user' })).toMatchObject({
      ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'unknown', code: 'delivery_unknown' } } },
    });
    expect(delivered).toBe(1);
  });

  it('records known fill separately from unknown submit and never repeats either effect', async () => {
    let delivered = 0;
    const settlement = { status: 'filled', code: 'filled', submit: { status: 'unknown', code: 'submit_unknown' } } as const;
    const { executor, records } = harness({ confidentialSecretFill: async () => {
      delivered += 1;
      return settlement;
    } });
    const reviewed = { ...request, submit: { controlId: 'sign-in', locator: '#sign-in', label: 'Sign in', consequence: 'Sign in to the reviewed account' } };
    const choice = { ...privateInput, request: reviewed, submit: true };
    await executor.execute('browser.automation.secret.fill', reviewed, context);
    const human = { authority: 'present_user', serverId: 'home' } as const;
    expect(await executor.continueConfidentialApprovalRequest(choice, human)).toEqual({ ok: true, result: settlement });
    expect(await executor.continueConfidentialApprovalRequest(choice, human)).toEqual({ ok: true, result: settlement });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'approval', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: settlement } } });
    expect(delivered).toBe(1);
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
  });

  it('rechecks the deciding human Machine admission after preparation rather than only the original requester', async () => {
    let admitted = false;
    let delivered = 0;
    const { executor, records } = harness({ confidentialSecretFill: async ({ isCurrent }) => {
      // The host callback is the external Home admission boundary; the original owner origin stays current.
      admitted = false;
      if (!await isCurrent()) return { status: 'refused', code: 'approval_changed' };
      delivered += 1;
      return { status: 'filled', code: 'filled' };
    } });
    await executor.execute('browser.automation.secret.fill', request, context);
    const humanContext = {
      authority: 'present_user' as const, serverId: 'home', verifyMachineAdmissionCurrent: async () => admitted,
    };
    expect(await executor.continueConfidentialApprovalRequest(privateInput, humanContext))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(records.get('approval')?.status).toBe('open');
    expect(delivered).toBe(0);
    admitted = true;
    expect(await executor.continueConfidentialApprovalRequest(privateInput, {
      ...humanContext,
    })).toEqual({ ok: true, result: { status: 'refused', code: 'approval_changed' } });
    expect(delivered).toBe(0);
  });

  it('binds a continuation through the host Home identity when its local profile alias differs', async () => {
    let delivered = 0;
    const { executor } = harness({ confidentialSecretFill: async () => {
      delivered += 1; return { status: 'filled', code: 'filled' };
    } });
    await executor.execute('browser.automation.secret.fill', request, { ...context, serverIdentityId: 'verified-home' });
    expect(await executor.continueConfidentialApprovalRequest(privateInput, {
      authority: 'present_user', serverId: 'local-home', serverIdentityId: 'different-home',
    })).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(delivered).toBe(0);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, {
      authority: 'present_user', serverId: 'local-home', serverIdentityId: 'verified-home',
    })).toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(delivered).toBe(1);
  });
});
