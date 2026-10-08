import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ instances: [] as Array<{
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  parameters: { command: string; args?: string[]; env?: Record<string, string> };
}>, tools: [] as Array<{ name: string; arguments: Record<string, unknown> }>, call: vi.fn() }));

// The subprocess/MCP transport is the system boundary; adapter parsing and admission stay real.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({ PATH: '/fixture/bin' }),
  StdioClientTransport: class {
    onmessage?: (message: JSONRPCMessage) => void;
    onclose?: () => void;
    close = vi.fn(async () => { this.onclose?.(); });
    start = vi.fn(async () => {});
    send = vi.fn(async (message: JSONRPCMessage) => {
      if (!('id' in message) || !('method' in message)) return;
      if (message.method === 'initialize') {
        this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: '0.31.0' } } });
        return;
      }
      if (message.method !== 'tools/call') return;
      const call = message.params as { name: string; arguments: Record<string, unknown> };
      native.tools.push(call);
      const result = await native.call(call, this);
      this.onmessage?.({ jsonrpc: '2.0', id: message.id, result });
    });
    constructor(readonly parameters: { command: string; args?: string[]; env?: Record<string, string> }) { native.instances.push(this); }
  },
}));

import { createManagedComputerDriver } from './managedComputerDriver';
import { createComputerCaptureSource } from '../source';
import { createComputerRoutes } from '../routes';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { startMachineLiveStreamFramePump } from '../../peer/mediation/stream/framePump';
import { createMachineLiveStreamRelayTerminator } from '../../peer/mediation/stream/relay';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonRuntimeActionExecutor } from '../../runtimeActionExecutor';
import type { MachineLiveStreamFrameV1, MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, FeaturesResponseSchema, decideApprovalRequestTransition, type ApprovalRequest } from '@happier-dev/protocol';

const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABk';
function captureResult() {
  return { content: [{ type: 'image', mimeType: 'image/png', data: png }], structuredContent: {
    pid: 42, window_id: 123, capture_id: 'capture-1', screenshot_width: 200, screenshot_height: 100,
    window_bounds: { x: -20, y: 30, width: 400, height: 300 }, screenshot_frame_valid: true,
    elements_complete: false, degraded_reason: 'x11_property_fallback_partial',
    elements: [{ element_index: 0, role: 'button', label: 'Apply', frame: { x: 2, y: 3, w: 20, h: 10 } }],
  } };
}

beforeEach(() => { native.instances.length = 0; native.tools.length = 0; native.call.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe.skipIf(process.platform !== 'linux')('managed native computer driver (X11)', () => {
  it('lists native app names with person-only preview pixels and an honest display refusal', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: {
      windows: [{ pid: target.pid, window_id: target.windowId, title: 'Document', app_name: 'Editor' }],
    } } : name === 'get_window_state' ? captureResult() : { structuredContent: { x11: true, xsend_event: true } });
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry(),
      executablePath: '/managed/native-driver', defaultDisplayId: ':73' });
    try {
      const human = await routes.dispatch('computer.targets.list', { machineId: 'machine' },
        { authority: 'present_user', defaultSessionId: 'session' });
      expect(human).toMatchObject({ targets: [{ target, title: 'Document', appName: 'Editor',
        thumbnail: { mimeType: 'image/png', base64: png, width: 200, height: 100 } }],
        displays: { status: 'unavailable', code: 'display_enumeration_unsupported' } });
      const captures = native.tools.filter(tool => tool.name === 'get_window_state').length;
      expect(native.tools.find(tool => tool.name === 'get_window_state')?.arguments)
        .toMatchObject({ include_accessibility_tree: false, max_image_dimension: 256 });
      const agent = await routes.dispatch('computer.targets.list', { machineId: 'machine' },
        { authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true });
      expect(agent).toMatchObject({ targets: [{ target, appName: 'Editor' }] });
      expect(JSON.stringify(agent)).not.toContain('thumbnail');
      expect(native.tools.filter(tool => tool.name === 'get_window_state')).toHaveLength(captures);
    } finally { await routes.dispose(); }
  });


  it('enforces see access for agent Actions while preserving person-owned stream input and app facts', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: {
      windows: [{ pid: target.pid, window_id: target.windowId, title: 'Document', app_name: 'Editor' }],
    } } : name === 'get_window_state' ? captureResult() : { structuredContent: { effect: 'unverifiable' } });
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/native-driver' });
    try {
      expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target, access: 'see' },
        { authority: 'present_user', defaultSessionId: 'session' })).toMatchObject({ access: 'see',
          approvalDisplay: { access: 'see', appName: 'Editor' } });
      const source = registry.list()[0]?.computer;
      if (!source) throw new Error('Missing selection');
      const observation = await source.observe();
      expect(await source.input(observation.captureId, { kind: 'click', x: 1, y: 1 }, 'agent'))
        .toMatchObject({ status: 'failed', code: 'computer_access_read_only' });
      expect(await routes.dispatch('computer.input', { machineId: 'machine', captureId: observation.captureId,
        operation: { kind: 'click', x: 1, y: 1 } }, { authority: 'present_user', defaultSessionId: 'session' }))
        .toMatchObject({ status: 'failed', code: 'computer_access_read_only' });
      expect(await routes.dispatch('computer.input', { machineId: 'machine', captureId: observation.captureId,
        operation: { kind: 'click', x: 1, y: 1 } }, { authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true }))
        .toMatchObject({ status: 'failed', code: 'computer_access_read_only' });
      expect(source.consentGranted()).toBe(false);
      const stream = await source.adapter.start({ streamId: 'stream', streamFamily: 'screen', sourceMachineId: 'machine', targetMachineId: 'machine',
        caps: {}, startRequest: { v: 1, streamId: 'stream', streamFamily: 'screen', sourceId: source.sourceId,
          routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine', codecId: 'image.frame.v1' },
        startedAtMs: 0, expiresAtMs: Number.POSITIVE_INFINITY, nowMs: () => 0,
        offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }), emitReceipt() {} });
      if (!stream.ok) throw new Error(stream.reasonCode);
      expect(stream.session.applySidebandControl?.({ v: 1, streamId: 'stream', sourceId: source.sourceId, eventId: 'tap-1', kind: 'tap', x: 0.1, y: 0.1 }))
        .toMatchObject({ ok: true });
      await vi.waitFor(() => expect(native.tools.filter(tool => tool.name === 'click')).toHaveLength(1));
      await stream.session.stop();
      expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target, access: 'use' },
        { authority: 'present_user', defaultSessionId: 'session' })).toMatchObject({ access: 'use', consentGranted: false });
    } finally { await routes.dispose(); }
  });

  it('publishes in-flight capture and a normalized clicked accessibility name, then clears activity', async () => {
    let finishCapture: ((value: unknown) => void) | undefined;
    let finishInput: ((value: unknown) => void) | undefined;
    native.call.mockImplementation(({ name }) => name === 'get_window_state'
      ? new Promise(resolve => { finishCapture = resolve; }) : new Promise(resolve => { finishInput = resolve; }));
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/native-driver' });
    let observing: ReturnType<typeof source.observe> | undefined;
    try {
      observing = source.observe();
      await vi.waitFor(() => expect(finishCapture).toBeDefined());
      expect(source.status()).toMatchObject({ activity: { kind: 'capture' } });
      const result = captureResult();
      finishCapture?.({ ...result, structuredContent: { ...result.structuredContent,
        elements: [{ element_index: 0, role: 'button', label: 'Sign in', value: 'private-value', frame: { x: 20, y: 60, w: 40, h: 30 } }] } });
      const capture = await observing;
      expect(source.status()).not.toHaveProperty('activity');
      const clicking = source.input(capture.captureId, { kind: 'click', x: 30, y: 15 }, 'agent');
      await vi.waitFor(() => expect(finishInput).toBeDefined());
      expect(source.status()).toMatchObject({ activity: { kind: 'click', targetLabel: 'Sign in' },
        activeTarget: { x: 0.15, y: 0.15, width: 0.1, height: 0.1, label: 'Sign in' } });
      expect(JSON.stringify(source.status())).not.toContain('private-value');
      finishInput?.({ structuredContent: { effect: 'unverifiable' } });
      expect(await clicking).toMatchObject({ status: 'dispatched', targetLabel: 'Sign in' });
      expect(source.status()).not.toHaveProperty('activity');
      expect(source.status()).not.toHaveProperty('activeTarget');
    } finally {
      finishCapture?.(captureResult());
      finishInput?.({ structuredContent: { effect: 'unverifiable' } });
      await observing?.catch(() => undefined);
      await source.close();
    }
  });
  it('redacts clicked names and never guesses keyboard focus or publishes typed input', async () => {
    const finishInput: { resolve?: (value: unknown) => void } = {};
    const readFinishInput = () => finishInput.resolve;
    const result = captureResult();
    native.call.mockImplementation(({ name }) => name === 'get_window_state' ? Promise.resolve({ ...result, structuredContent: {
      ...result.structuredContent, elements: [{ element_index: 0, role: 'entry',
        label: 'Open https://example.com/?token=secret', value: 'private-value', frame: { x: 20, y: 60, w: 40, h: 30 } }],
    } }) : new Promise(resolve => { finishInput.resolve = resolve; }));
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/native-driver' });
    try {
      let capture = await source.observe();
      const clicking = source.input(capture.captureId, { kind: 'click', x: 30, y: 15 }, 'agent');
      await vi.waitFor(() => expect(finishInput.resolve).toBeDefined());
      expect(source.status()).toMatchObject({ activity: { kind: 'click' }, activeTarget: { width: 0.1 } });
      expect(JSON.stringify(source.status())).not.toContain('secret');
      readFinishInput()?.({ structuredContent: { effect: 'unverifiable' } });
      expect(JSON.stringify(await clicking)).not.toContain('secret');
      finishInput.resolve = undefined;
      capture = await source.observe();
      const typing = source.input(capture.captureId, { kind: 'type', text: 'typed-password' }, 'agent');
      await vi.waitFor(() => expect(finishInput.resolve).toBeDefined());
      expect(source.status()).toMatchObject({ activity: { kind: 'type' } });
      expect(source.status()).not.toHaveProperty('activeTarget');
      expect(source.status().activity).not.toHaveProperty('targetLabel');
      expect(JSON.stringify(source.status())).not.toContain('typed-password');
      readFinishInput()?.({ structuredContent: { effect: 'unverifiable' } });
      expect(await typing).not.toHaveProperty('targetLabel');
    } finally { readFinishInput()?.({ structuredContent: { effect: 'unverifiable' } }); await source.close(); }
  });
  it('omits an editable value masquerading as its accessible name', async () => {
    let finishInput: ((value: unknown) => void) | undefined;
    const result = captureResult();
    native.call.mockImplementation(({ name }) => name === 'get_window_state' ? Promise.resolve({ ...result, structuredContent: {
      ...result.structuredContent, elements: [{ element_index: 0, role: 'password_text',
        label: 'private-password', value: 'private-password', frame: { x: 20, y: 60, w: 40, h: 30 } }],
    } }) : new Promise(resolve => { finishInput = resolve; }));
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/native-driver' });
    try {
      const capture = await source.observe();
      const clicking = source.input(capture.captureId, { kind: 'click', x: 30, y: 15 }, 'agent');
      await vi.waitFor(() => expect(finishInput).toBeDefined());
      expect(source.status()).toMatchObject({ activity: { kind: 'click' }, activeTarget: { width: 0.1 } });
      expect(JSON.stringify(source.status())).not.toContain('private-password');
      finishInput?.({ structuredContent: { effect: 'unverifiable' } });
      expect(await clicking).not.toHaveProperty('targetLabel');
    } finally { finishInput?.({ structuredContent: { effect: 'unverifiable' } }); await source.close(); }
  });
  it('uses host display facts for an explicitly created agent selection approval', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', machineDisplayName: 'Workstation',
      registry: createMachineLiveStreamCaptureRegistry(), executablePath: '/managed/native-driver', defaultDisplayId: ':73' });
    let stored: ApprovalRequest | undefined;
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null }, {
      runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: routes }),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({}) }) }),
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'explicit-approval' }; },
    });
    try {
      expect(await harness.executor.execute('approval.request.create', { actionId: 'computer.target.select',
        actionArgs: { machineId: 'machine', requestedTarget: 'Requested app' }, summary: 'Choose app',
        createdBy: { surface: 'mcp' }, preview: { computerApprovalDisplay: { machineDisplayName: 'Forged' } },
      }, { authority: 'account_automation', surface: 'agent', defaultSessionId: 'session', serverId: 'home', actionRequestId: 'explicit-select' }))
        .toMatchObject({ ok: true });
      expect(stored, JSON.stringify(stored)).toMatchObject({ preview: { computerApprovalDisplay: {
        machineDisplayName: 'Workstation', requiresTargetSelection: true,
      } } });
    } finally { await routes.dispose(); }
  });
  it.each([
    { name: 'as suggested', windowId: 123, access: 'use' as const },
    { name: 'with an edited window', windowId: 456, access: 'use' as const },
    { name: 'with downgraded access', windowId: 123, access: 'see' as const },
    { name: 'outside the user-side target list', windowId: 999, access: 'use' as const },
  ])('stores the human selection $name from the blocking approval, preserving the agent origin and suggestion', async ({ windowId, access }) => {
    const chosen = { ...target, windowId };
    native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: {
      windows: [{ pid: target.pid, window_id: target.windowId, title: 'Requested app' },
        { pid: target.pid, window_id: 456, title: 'Chosen app' }],
    } } : name === 'get_window_state' ? captureResult() : { structuredContent: {} });
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', machineDisplayName: 'Workstation', registry,
      executablePath: '/managed/native-driver', defaultDisplayId: ':73' });
    let stored: ApprovalRequest | undefined;
    const updates: ApprovalRequest[] = [];
    let created!: () => void;
    const requestCreated = new Promise<void>(resolve => { created = resolve; });
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null }, {
      runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: routes }),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({}) }) }),
      approvalsCreate: async ({ request }) => { stored = request; created(); return { artifactId: 'selection-approval' }; },
      approvalsGet: async () => stored ?? null,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing persisted approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = request;
        updates.push(request);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const controller = new AbortController();
    const context = { authority: 'account_automation' as const, surface: 'agent' as const, defaultSessionId: 'session',
      serverId: 'home', actionRequestId: 'select-request', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }), signal: controller.signal };
    const selecting = harness.executor.execute('computer.target.select', {
      machineId: 'machine', target, access: 'use', requestedTarget: 'Requested app',
    }, context);
    try {
      await Promise.race([requestCreated, selecting.then(result => {
        throw new Error(`Selection returned without requesting approval: ${JSON.stringify(result)}`);
      })]);
      expect(stored).toMatchObject({ actionArgs: { requestedTarget: 'Requested app' },
        preview: { computerApprovalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: true } } });
      expect(await harness.executor.execute('approval.request.decide', {
        artifactId: 'selection-approval', decision: 'approve', computerTarget: chosen,
      }, context)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(stored?.status).toBe('open');
      expect(registry.list()).toHaveLength(0);
      const decided = await harness.executor.execute('approval.request.decide', {
        artifactId: 'selection-approval', decision: 'approve', computerTarget: chosen, computerAccess: access,
      }, { ...context, surface: 'ui', authority: 'present_user' });
      if (windowId === 999) {
        expect(decided).toMatchObject({ ok: false, errorCode: 'computer_target_not_available' });
        expect(stored?.status).toBe('open');
        expect(registry.list()).toHaveLength(0);
        return;
      }
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
      expect(await selecting).toMatchObject({ ok: true, result: { selectedTarget: chosen, consentGranted: false, access } });
      expect(registry.list()[0]?.computer?.target).toEqual(chosen);
      expect(registry.list()[0]?.computer?.access).toBe(access);
      expect(stored).toMatchObject({ executionOriginV1: { authority: 'account_automation' } });
      expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'approved',
        actionArgs: expect.objectContaining({ target: chosen, access, requestedTarget: 'Requested app' }),
        decision: expect.objectContaining({ authority: 'present_user' }),
      })]));
      expect(stored).toMatchObject({ status: 'executed', actionArgs: { access } });
      expect(stored?.actionArgs).not.toHaveProperty('target');
      expect(stored?.actionArgs).not.toHaveProperty('sourceId');
    } finally { controller.abort(); await selecting.catch(() => undefined); await routes.dispose(); }
  });
  it.each(['computer.targets.list', 'computer.target.select', 'computer.control.interrupt', 'computer.control.handBack'] as const)(
    'routes agent %s through approval and the real native owner without human authority', async actionId => {
      native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: {
        windows: [{ pid: target.pid, window_id: target.windowId, title: 'Fixture' }],
      } } : name === 'get_window_state' ? captureResult() : { structuredContent: {} });
      const registry = createMachineLiveStreamCaptureRegistry();
      const routes = createComputerRoutes({ machineId: 'machine', machineDisplayName: 'Workstation', registry,
        executablePath: '/managed/native-driver', defaultDisplayId: ':73' });
      const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: routes }),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({}) }) });
      let decision: 'approve' | 'reject' = 'reject';
      let requested: ApprovalRequest | undefined;
      const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null }, {
        runtimeActionExecute,
        approvalsCreate: async ({ request }) => { requested = request; return { artifactId: 'approval' }; },
        approvalsGet: async () => null,
        approvalsWaitForDecision: async ({ request }) => ({ decision, request }),
        approvalsUpdate: async () => ({ ok: true }),
        isApprovalExecutionOriginCurrent: async () => true,
      });
      const context = { authority: 'account_automation' as const, surface: 'agent' as const,
        defaultSessionId: 'session', serverId: 'home', actionRequestId: `request:${actionId}`,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
      const args = actionId === 'computer.target.select' ? { machineId: 'machine', requestedTarget: 'Fixture' }
        : actionId === 'computer.targets.list' ? { machineId: 'machine', displayId: ':73' } : { machineId: 'machine' };
      try {
        if (actionId === 'computer.control.interrupt' || actionId === 'computer.control.handBack') {
          await routes.dispatch('computer.target.select', { machineId: 'machine', target }, { authority: 'present_user', defaultSessionId: 'session' });
        }
        const before = registry.list()[0]?.computer?.status();
        const listedBefore = native.tools.filter(tool => tool.name === 'list_windows').length;
        expect(await harness.executor.execute(actionId, args, context)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        expect(native.tools.filter(tool => tool.name === 'list_windows')).toHaveLength(listedBefore);
        expect(registry.list()[0]?.computer?.status()).toEqual(before);
        expect(requested).toMatchObject({ actionId, executionOriginV1: { authority: 'account_automation' } });
        decision = 'approve';
        const result = await harness.executor.execute(actionId, args, context);
        expect(result).toMatchObject({ ok: true });
        if (actionId === 'computer.targets.list') expect(result).toMatchObject({ result: { targets: [{ target, title: 'Fixture' }] } });
        if (actionId === 'computer.target.select') expect(registry.list()[0]?.computer?.target).toEqual(target);
        if (actionId === 'computer.control.interrupt') expect(registry.list()[0]?.computer?.status().controller).toBe('human');
        if (actionId === 'computer.control.handBack') {
          const source = registry.list()[0]?.computer;
          if (!source) throw new Error('Missing target');
          const observed = await source.observe();
          await source.interrupt();
          expect(await harness.executor.execute(actionId, args, context)).toMatchObject({ ok: true, result: { status: 'dispatched' } });
          expect(await source.input(observed.captureId, { kind: 'press', key: 'Return' }, 'agent')).toMatchObject({ status: 'failed', code: 'observation_required' });
        }
        requested = undefined;
        expect(await harness.executor.execute(actionId, args, { ...context,
          actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }),
        })).toMatchObject({ ok: true });
        expect(requested).toBeUndefined();
        if (actionId !== 'computer.targets.list') expect(registry.list()[0]?.computer?.consentGranted()).toBe(false);
      } finally { await routes.dispose(); }
    });

  it('refuses cross-session selection of the same physical target, including concurrent selection', async () => {
    let releaseInput: (() => void) | undefined;
    let closing: Promise<void> | undefined;
    native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: {
      windows: [{ pid: target.pid, window_id: target.windowId, title: 'Fixture' }],
    } } : name === 'get_window_state' ? captureResult() : new Promise(resolve => {
      releaseInput = () => resolve({ structuredContent: { effect: 'unverifiable' } });
    }));
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/native-driver' });
    const select = (sessionId: string) => routes.dispatch('computer.target.select', { machineId: 'machine', target },
      { authority: 'present_user', defaultSessionId: sessionId });
    try {
      const results = await Promise.all([select('session-a'), select('session-b')]);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ selectedTarget: target, consentGranted: false }),
        expect.objectContaining({ ok: false, errorCode: 'computer_target_in_use' }),
      ]));
      expect(registry.list()).toHaveLength(1);
      const owner = registry.list()[0]?.computer;
      if (!owner) throw new Error('Missing selected target owner');
      const otherSession = owner.sessionId === 'session-a' ? 'session-b' : 'session-a';
      expect(await routes.dispatch('computer.target.get', { machineId: 'machine' },
        { authority: 'account_automation', defaultSessionId: otherSession }))
        .toMatchObject({ consentGranted: false, approvalDisplay: { requiresTargetSelection: true } });
      const observation = await owner.observe();
      const pendingInput = owner.input(observation.captureId, { kind: 'click', x: 1, y: 1 }, 'agent');
      await vi.waitFor(() => expect(releaseInput).toBeDefined());
      closing = routes.closeSession(owner.sessionId);
      expect(await select(otherSession)).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
      releaseInput?.();
      await pendingInput;
      await closing;
      expect(await select(otherSession)).toMatchObject({ selectedTarget: target, consentGranted: false });
    } finally { releaseInput?.(); await closing; await routes.dispose(); }
  });

  it('resumes uncapped native capture after an admitted relay viewer acknowledgement', async () => {
    vi.useFakeTimers();
    native.call.mockImplementation(async () => captureResult());
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/native-driver' });
    const envelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
    const now = Date.now();
    const relay = createMachineLiveStreamRelayTerminator({ machineId: 'machine_source', captureAdapter: source.adapter,
      nowMs: () => Date.now(), emitEnvelope: envelope => envelopes.push(envelope) });
    const receivedFrames = () => envelopes.flatMap(envelope => envelope.message.kind === 'frame' ? [envelope.message.frame] : []);
    const receivedImages = () => receivedFrames().filter(frame => frame.payloadKind === 'image_keyframe');
    try {
      const started = await relay.start({ v: 1, streamId: 'stream', streamFamily: 'screen', routeKind: 'server_relay',
        sourceMachineId: 'machine_source', targetMachineId: 'machine_target', codecId: 'image.frame.v1',
        authorization: { payload: { v: 1, grantId: 'grant', accountId: 'account', sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target', flowKind: 'live_stream', routeKind: 'server_relay', streamId: 'stream',
          streamFamily: 'screen', codecId: 'image.frame.v1', iat: now, exp: now + 60_000, aud: 'happier-live-stream-relay-authorization' },
          signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' } },
      });
      if (!started.ok) throw new Error(started.reasonCode);
      await vi.advanceTimersByTimeAsync(25);
      expect(receivedImages()).toMatchObject([{ payloadBase64: png }]);
      const metadata = receivedFrames().filter(frame => frame.payloadKind === 'metadata');
      expect(metadata).toHaveLength(1);
      expect(JSON.parse(Buffer.from(metadata[0].payloadBase64, 'base64').toString('utf8'))).toMatchObject({ target, sourceId: source.sourceId });
      const captureCount = native.tools.filter(tool => tool.name === 'get_window_state').length;
      expect(captureCount).toBe(1);
      expect(relay.applyControl({ v: 1, sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
        message: { kind: 'control', control: { v: 1, streamId: 'stream', kind: 'ack', nextSequence: receivedFrames().at(-1)!.sequence + 1, windowFrames: 1 } } }))
        .toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(25);
      expect(receivedImages()).toMatchObject([{ payloadBase64: png }, { payloadBase64: png }]);
      expect(native.tools.filter(tool => tool.name === 'get_window_state')).toHaveLength(captureCount + 1);
    } finally { await relay.dispose(); await source.close(); }
  });

  it('paces an uncapped start by viewer credit and ack without continued native polling', async () => {
    vi.useFakeTimers();
    native.call.mockImplementation(async () => captureResult());
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/native-driver' });
    const frames: MachineLiveStreamFrameV1[] = [];
    const caps = { maxFrameBytes: 100_000 };
    const pump = startMachineLiveStreamFramePump({ streamId: 'stream', caps, startedAtMs: Date.now(), nowMs: () => Date.now(),
      emitFrame: frame => frames.push(frame), emitReceipt() {} });
    pump.applyControl({ v: 1, streamId: 'stream', kind: 'ack', nextSequence: 1, windowFrames: 0 });
    try {
      const stream = await source.adapter.start({ streamId: 'stream', streamFamily: 'screen', sourceMachineId: 'machine', targetMachineId: 'machine',
        caps, startRequest: { v: 1, streamId: 'stream', streamFamily: 'screen', sourceId: source.sourceId,
          routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine', codecId: 'image.frame.v1', ...caps },
        startedAtMs: Date.now(), expiresAtMs: Number.POSITIVE_INFINITY, nowMs: () => Date.now(),
        offerFrame: pump.offerFrame, applyControl: pump.applyControl, emitReceipt() {} });
      if (!stream.ok) throw new Error(stream.reasonCode);
      await vi.advanceTimersByTimeAsync(25);
      expect(native.tools.filter(tool => tool.name === 'get_window_state')).toHaveLength(1);
      expect(frames).toHaveLength(0);
      const ack = { v: 1 as const, streamId: 'stream', kind: 'ack' as const, nextSequence: 1, windowFrames: 1 };
      expect(pump.applyControl(ack)).toEqual({ ok: true });
      expect(stream.session.applyControl?.(ack)).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(25);
      expect(frames).toHaveLength(1);
      expect(native.tools.filter(tool => tool.name === 'get_window_state')).toHaveLength(2);
      await stream.session.stop();
    } finally { await source.close(); }
  });

  it('stops type admission when takeover aborts during the read-only geometry check', async () => {
    let finish: ((value: unknown) => void) | undefined;
    let observations = 0;
    native.call.mockImplementation(({ name }) => {
      if (name === 'get_window_state' && observations++ === 0) return Promise.resolve(captureResult());
      if (name === 'get_window_state') return new Promise(resolve => { finish = resolve; });
      return Promise.resolve({ content: [], structuredContent: { effect: 'unverifiable' } });
    });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const observation = await driver.capture(target);
      const controller = new AbortController();
      const pending = driver.input(target, observation.captureId, { kind: 'type', text: 'stop before dispatch' }, { signal: controller.signal });
      await vi.waitFor(() => expect(finish).toBeDefined());
      controller.abort();
      finish?.(captureResult());
      expect(await pending).toEqual({ status: 'interrupted', completion: 'known' });
      expect(native.tools.filter(tool => tool.name === 'type_text' || tool.name === 'press_key')).toHaveLength(0);
    } finally { await driver.close(); }
  });

  it('replaces previous model binding when a new observation is captured', async () => {
    let next = 0;
    native.call.mockImplementation(async ({ name }) => {
      if (name !== 'get_window_state') return { content: [], structuredContent: { effect: 'unverifiable' } };
      const result = captureResult();
      return { ...result, structuredContent: { ...result.structuredContent, capture_id: `capture-${next++}` } };
    });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const previous = await driver.capture(target);
      const current = await driver.capture(target);
      expect(await driver.input(target, previous.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'failed', code: 'stale_capture' });
      expect(await driver.input(target, current.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'dispatched' });
    } finally { await driver.close(); }
  });

  it('inherits X11 authentication and the accessibility bus for the explicitly selected display', async () => {
    vi.stubEnv('XAUTHORITY', '/fixture/xauth');
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/fixture/bus');
    vi.stubEnv('XDG_RUNTIME_DIR', '/fixture/runtime');
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      expect(native.instances[0]?.parameters.env).toMatchObject({ DISPLAY: ':73', XAUTHORITY: '/fixture/xauth',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus', XDG_RUNTIME_DIR: '/fixture/runtime' });
    } finally { await driver.close(); }
  });

  it('reports unknown completion for an input failure that does not prove refusal before dispatch', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult() : {
      isError: true, content: [], structuredContent: { effect: 'refused', error: { code: 'tool_error' } },
    });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'interrupted', completion: 'unknown' });
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'failed', code: 'driver_unavailable' });
    } finally { await driver.close(); }
  });

  it('keeps model capture actionable while viewer frames use a read-only process and closes both', async () => {
    const processTokens = new Map<object, string[]>();
    let nextCapture = 0;
    native.call.mockImplementation(async ({ name, arguments: args }, process: object) => {
      const tokens = processTokens.get(process) ?? [];
      processTokens.set(process, tokens);
      if (name === 'get_window_state') {
        const token = `capture-${nextCapture++}`;
        tokens.push(token);
        // The pinned driver's actual capture registry retains at most 32 tokens.
        if (tokens.length > 32) tokens.shift();
        const result = captureResult();
        return { ...result, structuredContent: { ...result.structuredContent, capture_id: token } };
      }
      if (name === 'click' && tokens.includes(args.capture_id)) return { content: [], structuredContent: { effect: 'unverifiable', route: 'synthetic_events' } };
      return { isError: true, content: [], structuredContent: { effect: 'refused', error: { code: 'capture_action_refused' } } };
    });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    const observation = await driver.capture(target);
    for (let index = 0; index < 33; index++) {
      const frame = await driver.captureFrame(target);
      expect(frame.png).toEqual(observation.png);
    }
    expect(await driver.input(target, observation.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'dispatched' });
    expect(native.instances).toHaveLength(2);
    await driver.close();
    for (const process of native.instances) expect(process.close).toHaveBeenCalledOnce();
  });

  it('binds image geometry to the selected target and delegates capture coordinates exactly once', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult() : {
      content: [], structuredContent: { effect: 'unverifiable', route: 'synthetic_events' },
    });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(capture.png).toEqual(Buffer.from(png, 'base64'));
      expect(capture.geometry).toEqual({ captureWidth: 200, captureHeight: 100, nativeWidth: 400, nativeHeight: 300,
        originX: -20, originY: 30, scaleX: 2, scaleY: 3, crop: { x: 0, y: 0, width: 400, height: 300 } });
      expect(capture.accessibility).toMatchObject({ complete: false, degradedReason: 'x11_property_fallback_partial',
        nodes: [{ id: '0', role: 'button', name: 'Apply', bounds: { x: 2, y: 3, width: 20, height: 10 } }] });
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 50, y: 25 })).toEqual({ status: 'dispatched' });
      expect(native.tools.at(-1)).toEqual({ name: 'click', arguments: { pid: 42, window_id: 123, capture_id: 'capture-1', x: 50, y: 25, delivery_mode: 'background', button: 'left' } });
      expect(native.instances[0]?.parameters).toMatchObject({ command: '/managed/cua-driver', args: ['mcp', '--direct', '--embedded', '--no-overlay'], env: { DISPLAY: ':73', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' } });
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 50, y: 25 })).toEqual({ status: 'failed', code: 'stale_capture' });
    } finally { await driver.close(); }
  });

  it('refuses foreign displays, unsupported desktop targets and changed capture identities', async () => {
    native.call.mockResolvedValue(captureResult());
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      await expect(driver.capture({ ...target, displayId: ':74' })).rejects.toMatchObject({ code: 'target_mismatch' });
      await expect(driver.capture({ kind: 'display', displayId: ':73' })).rejects.toMatchObject({ code: 'target_unsupported' });
      const capture = await driver.capture(target);
      expect(await driver.input({ ...target, windowId: 124 }, capture.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'failed', code: 'stale_capture' });
      expect(native.tools.filter(x => x.name === 'click')).toHaveLength(0);
    } finally { await driver.close(); }
  });

  it('waits for native input settlement when closing and quarantines a lost reply without retry', async () => {
    let finish: ((value: unknown) => void) | undefined;
    native.call.mockImplementation(({ name }) => name === 'get_window_state' ? Promise.resolve(captureResult()) : new Promise(resolve => { finish = resolve; }));
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    const capture = await driver.capture(target);
    const input = driver.input(target, capture.captureId, { kind: 'click', x: 1, y: 1 });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const close = driver.close();
    await Promise.resolve();
    expect(native.instances[0]?.close).not.toHaveBeenCalled();
    finish?.({ content: [], structuredContent: { effect: 'unverifiable', route: 'synthetic_events' } });
    expect(await input).toEqual({ status: 'dispatched' });
    await close;

    native.call.mockImplementation(({ name }) => name === 'get_window_state' ? Promise.resolve(captureResult()) : new Promise(() => {}));
    const second = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    const latest = await second.capture(target);
    const lost = second.input(target, latest.captureId, { kind: 'click', x: 1, y: 1 });
    await vi.waitFor(() => expect(native.tools.filter(x => x.name === 'click')).toHaveLength(2));
    native.instances[1]?.onclose?.();
    expect(await lost).toEqual({ status: 'interrupted', completion: 'unknown' });
    expect(await second.input(target, latest.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'failed', code: 'driver_unavailable' });
    await second.close();
  });
});
