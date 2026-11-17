import { describe, expect, it, vi } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

describe('machine and Home connection Action parity', () => {
  it('exposes managed installation questions on the answering client with automation Ask and exact prompt identity', () => {
    const id = ActionIdSchema.parse('machines.managed.bootstrap.respond');
    const spec = getActionSpec(id);
    expect(spec).toMatchObject({ executionPlacement: 'client', safety: 'danger',
      surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false } });
    const input = { serverId: 'profile', homeId: 'home', managedId: 'managed', operationId: 'creation', taskId: 'install',
      purpose: 'approve', prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign in to Guest?' }, approved: false };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, machineId: 'injected-controller' }).success).toBe(false);
    expect(listActionSpecsForCatalogSurface({ surface: 'agent' }).map(action => action.id)).toContain(id);
    expect(listActionSpecsForCatalogSurface({ surface: 'mcp' }).map(action => action.id)).toContain(id);
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ actionId: id, spec, context }).required).toBe(true);
      const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [id]: [surface] } });
      expect(resolveActionApprovalRouting({ actionId: id, spec, context, settings }).required).toBe(false);
      expect(resolveActionApprovalRouting({ actionId: id, spec, context, settings: normalizeActionsSettingsV1({ ...settings,
        actions: { [id]: { approvalRequiredSurfaces: [surface] } } }) }).required).toBe(true);
    }
  });
  it('admits establishment only as an exact transient response and keeps its password out of previews and cold approval state', async () => {
    const actionId = ActionIdSchema.parse('machines.managed.bootstrap.respond');
    const spec = getActionSpec(actionId);
    const input = { serverId: 'profile', homeId: 'home', managedId: 'managed', operationId: 'creation', taskId: 'install',
      purpose: 'establish', promptId: 'administrator-1', password: 'private-establishment-password' };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [{ ...input, approved: true }, { ...input, promptId: '' }, { ...input, password: '' },
      { ...input, purpose: 'approve' }, { ...input, machineId: 'other-controller' }]) {
      expect(spec.inputSchema.safeParse(invalid).success).toBe(false);
    }
    const coordinator = createBlockingApprovalCoordinator();
    let stored: ApprovalRequest | null = null;
    const retained: unknown[] = [];
    const delivered: unknown[] = [];
    const observations: unknown[] = [];
    const previews: unknown[] = [];
    // Approval persistence and the answering app transport are external boundaries.
    const deps = { approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
      stored = request; retained.push(JSON.parse(JSON.stringify(request))); return { artifactId: 'establish-approval' };
    }, approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
      stored = request; retained.push(JSON.parse(JSON.stringify(request))); return { ok: true as const };
    }, approvalsGet: async () => stored, approvalsWaitForDecision: coordinator.waitForDecision,
    isApprovalExecutionOriginCurrent: async () => true,
    buildApprovalPreview: async (review: Parameters<NonNullable<ActionExecutorDeps['buildApprovalPreview']>>[0]) => {
      previews.push(review); return review.defaultPreview;
    },
    observeActionExecution: async (observation: unknown) => { observations.push(observation); },
    machineManagedInstallationRespond: async (answer: unknown) => { delivered.push(answer); return { taskId: input.taskId }; },
    } as unknown as ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const pending = executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'host' }, serverId: 'profile', defaultSessionMachineId: 'controller', actionRequestId: 'establish-attempt' });
    try {
      await vi.waitFor(() => expect(coordinator.getLiveWaiterCount('establish-approval')).toBe(1));
      const request = stored as ApprovalRequest | null;
      if (!request) throw new Error('Expected establishment approval');
      expect(JSON.stringify(request)).not.toContain(input.password);
      expect(request.actionArgs).toMatchObject({ purpose: 'establish', promptId: input.promptId });
      expect(request.actionArgs).not.toHaveProperty('password');
      expect(delivered).toEqual([]);
      await coordinator.resolveBlockingDecision({ artifactId: 'establish-approval', request, decision: 'approve', decisionAuthority: 'present_user' });
      expect(await pending).toEqual({ ok: true, result: { taskId: input.taskId } });
      expect(delivered).toEqual([input]);
      expect(JSON.stringify([...retained, ...observations, ...previews])).not.toContain(input.password);
      expect(observations).toHaveLength(1);
    } finally { coordinator.dispose(); }
  });
  it('identifies the missing displayed question in a stale managed bootstrap answer before delivery', async () => {
    // Rerun 50's QA caller omitted prompt. Keep actual admission and the
    // Protocol schema; only the answering client is a system boundary.
    const deliveries: unknown[] = [];
    const executor = createActionExecutor({ machineManagedInstallationRespond: async input => {
      deliveries.push(input);
      return { taskId: input.taskId };
    } } as ActionExecutorDeps);
    const input = { serverId: 'home', homeId: 'home', managedId: 'managed', operationId: 'creation', taskId: 'install', purpose: 'approve', approved: true };
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation', serverId: 'home', bypassApprovals: true } as const;
      expect(await executor.execute('machines.managed.bootstrap.respond', input, context)).toMatchObject({
        ok: false, errorCode: 'invalid_parameters', details: { issues: expect.arrayContaining([
          expect.objectContaining({ path: ['prompt'] }),
        ]) },
      });
    }
    expect(deliveries).toEqual([]);
  });
  it('publishes machine page operations with the same caller input on UI and CLI', async () => {
    for (const [id, input, result] of [
      ['machines.metadata.update', { serverId: 'home', machineId: 'machine', expectedVersion: 3, patch: { displayName: 'Desk' } }, { version: 4 }],
      ['machines.daemon.stop', { serverId: 'home', machineId: 'machine' }, { message: 'Stopped' }],
      ['machines.remove', { serverId: 'home', machineId: 'machine' }, { ok: true, machineAlreadyRevoked: false, providerCleanup: 'complete' }],
      ['machines.capabilities.install', { serverId: 'home', machineId: 'machine', capabilityId: 'dep.codex-acp', method: 'install' }, { supported: true, response: { ok: true, result: { logPath: '/tmp/install.log' } } }],
    ] as const) {
      const actionId = ActionIdSchema.parse(id);
      const spec = getActionSpec(actionId);
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, mcp: true });
      expect(spec.inputSchema.parse(input)).toEqual(input);
      const seen: unknown[] = [];
      const deps = { machinePageAction: async (request: unknown) => { seen.push(request); return result; } } as unknown as ActionExecutorDeps;
      const executor = createActionExecutor(deps);
      expect(await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: 'home', bypassApprovals: true }))
        .toEqual({ ok: true, result });
      expect(await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user', serverId: 'home', bypassApprovals: true }))
        .toEqual({ ok: true, result });
      expect(seen).toHaveLength(2);
    }
    const install = getActionSpec('machines.capabilities.install');
    expect(install).toMatchObject({ safety: 'danger', executionPlacement: 'machine', sideEffectClass: 'danger' });
    expect(install.inputSchema.safeParse({ machineId: 'machine', capabilityId: 'cli.codex', method: 'install' }).success).toBe(false);
    expect(install.inputSchema.safeParse({ machineId: 'machine', capabilityId: 'dep.codex-acp', method: 'probe' }).success).toBe(false);
    expect(install.inputSchema.safeParse({ machineId: 'machine', capabilityId: 'dep.codex-acp', method: 'install', params: {} }).success).toBe(false);
  });
  it('lists machine terminals as a read Action with exact Home routing and preserved unavailable/refused outcomes', async () => {
    const id = ActionIdSchema.parse('machines.terminal.list');
    const spec = getActionSpec(id);
    expect(spec).toMatchObject({ sideEffectClass: 'read', safety: 'safe', executionPlacement: 'machine' });
    expect(spec.inputSchema.safeParse({ machineId: 'machine', terminalId: 'injected' }).success).toBe(false);
    const seen: unknown[] = [];
    const result = { ok: true as const, terminals: [{ terminalId: 'pty', terminalKey: 'shell', cwd: '/project', sessionId: 'other', ended: false, exit: null }] };
    const executor = createActionExecutor({ machineTerminalAction: async (request: unknown) => { seen.push(request); return result; } } as unknown as ActionExecutorDeps);
    expect(await executor.execute(id, { serverId: 'home', machineId: 'machine' }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result });
    expect(seen).toEqual([{ actionId: id, input: { machineId: 'machine', serverId: 'home' },
      context: expect.objectContaining({ surface: 'cli', authority: 'present_user', serverId: 'home' }) }]);
    const unavailable = createActionExecutor({ machineTerminalAction: async () => null } as unknown as ActionExecutorDeps);
    expect(await unavailable.execute(id, { serverId: 'home', machineId: 'machine' }, { surface: 'ui', authority: 'present_user' })).toEqual({ ok: true, result: null });
    const refused = createActionExecutor({ machineTerminalAction: async () => ({ ok: false, errorCode: 'terminal_disabled', error: 'disabled' }) } as unknown as ActionExecutorDeps);
    expect(await refused.execute(id, { serverId: 'home', machineId: 'machine' }, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'terminal_disabled' });
  });
  it('publishes SSH task lifecycle actions instead of treating command preparation as installation', async () => {
    for (const id of ['machines.add.ssh.start', 'machines.add.ssh.status', 'machines.add.ssh.respond', 'machines.add.ssh.cancel']) {
      expect(ActionIdSchema.safeParse(id).success).toBe(true);
      expect(getActionSpec(ActionIdSchema.parse(id)).executionPlacement).toBe('client');
    }
    const start = getActionSpec('machines.add.ssh.start');
    expect(start.inputSchema.safeParse({ serverId: 'home', savedHostId: 'box', expectedHostRevision: 4 }).success).toBe(true);
    expect(start.inputSchema.safeParse({ serverId: 'home', savedHostId: 'box', expectedHostRevision: 4, password: 'secret' }).success).toBe(false);
    expect(start.inputSchema.safeParse({ serverId: 'home', savedHostId: 'box', expectedHostRevision: 4, host: 'other-target' }).success).toBe(false);
    const respond = getActionSpec('machines.add.ssh.respond');
    expect(respond.inputSchema.safeParse({ taskId: 'task', answer: { kind: 'ssh.password' } }).success).toBe(true);
    expect(respond.inputSchema.safeParse({ taskId: 'task', answer: { kind: 'ssh.password', password: 'secret' } }).success).toBe(false);
    expect(start.surfaces.cli).toBe(true);
  });
  it('admits an exact saved SSH host reference while refusing competing targets and secret material', () => {
    const schema = getActionSpec('machines.add.ssh.start').inputSchema;
    const saved = { serverId: 'home', savedHostId: 'host', expectedHostRevision: 4 };
    expect(schema.safeParse(saved).success).toBe(true);
    expect(schema.safeParse({ ...saved, host: 'different-target' }).success).toBe(false);
    expect(schema.safeParse({ ...saved, accountId: 'different-account' }).success).toBe(false);
    expect(schema.safeParse({ ...saved, password: 'secret' }).success).toBe(false);
    expect(schema.safeParse({ serverId: 'home', savedHostId: 'host' }).success).toBe(false);
  });
  it('returns the canonical Home connection outcome and rejects removed classifications', async () => {
    const id = ActionIdSchema.parse('homes.connect');
    const addresses: string[] = [];
    // This port is the executing client's persisted Home and network boundary.
    const executor = createActionExecutor({ homeConnect: async (input: { address: string }) => {
      addresses.push(input.address);
      return { kind: 'connected', serverId: 'home', serverUrl: 'https://home.example', name: 'Home' };
    } } as unknown as ActionExecutorDeps);
    expect(await executor.execute(id, { address: 'https://home.example' }, { surface: 'ui' }))
      .toEqual({ ok: true, result: { kind: 'connected', serverId: 'home', serverUrl: 'https://home.example', name: 'Home' } });
    const spec = getActionSpec(id);
    expect(spec.executionPlacement).toBe('client');
    expect(spec.inputSchema.safeParse({ address: 'https://home.example', accountId: 'other' }).success).toBe(false);
    expect(await executor.execute(id, { address: 'https://other.example', accountId: 'other' }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(addresses).toEqual(['https://home.example']);
    expect(spec.outputSchema.safeParse({ kind: 'sign_in_service', endpointUrl: 'https://sign-in.example', name: 'Sign in' }).success).toBe(false);
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
    expect(listActionSpecsForCatalogSurface({ surface: 'agent' }).map((action) => action.id)).toContain(id);
  });

  it('opens a machine terminal through the existing request contract and preserves daemon refusal', async () => {
    const id = ActionIdSchema.parse('machines.terminal.open');
    const request = { serverId: 'home', machineId: 'machine', terminalKey: 'shell', cwd: '/project', cols: 100, rows: 30 };
    const seen: unknown[] = [];
    // The daemon PTY adapter is the external process boundary.
    const executor = createActionExecutor({ machineTerminalAction: async (request: unknown) => {
      seen.push(request);
      return { ok: true, terminalId: 'pty', reused: false };
    } } as unknown as ActionExecutorDeps);
    expect(await executor.execute(id, request, { surface: 'ui', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { ok: true, terminalId: 'pty', reused: false } });
    expect(seen).toEqual([{ actionId: id, input: request,
      context: expect.objectContaining({ surface: 'ui', authority: 'present_user', serverId: 'home' }) }]);
    const refused = createActionExecutor({ machineTerminalAction: async () => ({
      ok: false, errorCode: 'terminal_disabled', error: 'Disabled',
    }) } as unknown as ActionExecutorDeps);
    expect(await refused.execute(id, request, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'terminal_disabled' });
    expect(getActionSpec(id).inputSchema.safeParse({ ...request, unexpected: true }).success).toBe(false);
  });

  it('prepares SSH and another-computer setup commands without installing anything', async () => {
    const id = ActionIdSchema.parse('machines.add.command');
    const executor = createActionExecutor({ machineAddCommand: async () => ({ command: 'install-and-setup', descriptorFileRequired: false }) } as unknown as ActionExecutorDeps);
    expect(await executor.execute(id, { method: 'another_computer', os: 'windows', serverId: 'home' }, { surface: 'ui' }))
      .toEqual({ ok: true, result: { command: 'install-and-setup', descriptorFileRequired: false } });
    const schema = getActionSpec(id).inputSchema;
    expect(schema.safeParse({ method: 'ssh', os: 'linux', serverId: 'home' }).success).toBe(false);
    expect(schema.safeParse({ method: 'ssh', os: 'linux', serverId: 'home', host: 'host', port: 65536 }).success).toBe(false);
  });

  it.each(['ui', 'cli'] as const)('issues a pairing link to the person on %s with the canonical expiry', async surface => {
    const id = ActionIdSchema.parse('machines.pairing.create');
    const executor = createActionExecutor({ machinePairingCreate: async () => ({
      pairId: 'pair', link: 'happier:///pair?payload=opaque', expiresAtMs: 1000,
    }) } as unknown as ActionExecutorDeps);
    expect(await executor.execute(id, { serverId: 'home' }, { surface, authority: 'present_user', bypassApprovals: true }))
      .toEqual({ ok: true, result: { pairId: 'pair', link: 'happier:///pair?payload=opaque', expiresAtMs: 1000 } });
    expect(getActionSpec(id).executionPlacement).toBe('client');
  });

  it.each(['agent', 'mcp'] as const)('never delivers a pairing credential to %s, even after person approval', async surface => {
    let issued = false;
    // Trusted device enrollment is the external credential boundary.
    const executor = createActionExecutor({ machinePairingCreate: async () => {
      issued = true;
      return { pairId: 'pair', link: 'happier:///pair?payload=fixture', expiresAtMs: 1000 };
    } });
    const result = await executor.execute('machines.pairing.create', { serverId: 'home' }, {
      surface, authority: 'present_user', bypassApprovals: true,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled',
      details: { surface, reason: 'unsupported_surface' } });
    expect(issued).toBe(false);
    expect(result).not.toHaveProperty('result.link');
    expect(listActionSpecsForCatalogSurface({ surface }).map(action => action.id)).not.toContain('machines.pairing.create');
  });
});
