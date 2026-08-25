import type { BrowserAutomationActionRequestV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserAutomationCdpAdapter,
  type BrowserAutomationCdpTransport,
} from './cdp';

function transport(overrides: Partial<BrowserAutomationCdpTransport> = {}): BrowserAutomationCdpTransport {
  return {
    ownsView: vi.fn(() => true),
    dispatchControlCommand: vi.fn(async () => ({
      v: 1 as const,
      commandId: 'cmd',
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    })),
    dispatchPageQuery: vi.fn(async () => ({ ok: true as const, data: { nodes: 2 } })),
    ...overrides,
  };
}

function request(
  overrides: Partial<BrowserAutomationActionRequestV1> = {},
): BrowserAutomationActionRequestV1 {
  return {
    v: 1,
    automationRequestId: 'req_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 1,
    requestedBy: 'agent',
    requesterRef: { kind: 'agent', id: 'agent_1' },
    actionKind: 'snapshot',
    payload: {},
    timeoutMs: 5_000,
    ...overrides,
  } as BrowserAutomationActionRequestV1;
}

describe('browser automation CDP adapter', () => {
  it('reports the chromiumSidecar adapter kind', () => {
    const adapter = createBrowserAutomationCdpAdapter({ transport: transport() });
    expect(adapter.adapterKind).toBe('chromiumSidecar');
  });

  it('declares supportedOperations excluding mutating-input verbs when no input transport is bound (BA-6)', () => {
    const adapter = createBrowserAutomationCdpAdapter({ transport: transport() });
    const ops = adapter.supportedOperations;
    expect(ops).toBeDefined();
    if (!ops) return;
    // Read-only queries + navigation are always supported.
    expect(ops.has('snapshot')).toBe(true);
    expect(ops.has('navigate')).toBe(true);
    expect(ops.has('reload')).toBe(true);
    // Mutating-input verbs require the CDP input transport — negotiated away when absent.
    expect(ops.has('click')).toBe(false);
    expect(ops.has('type')).toBe(false);
    // Ops the adapter does not implement are never advertised.
    expect(ops.has('evaluate')).toBe(false);
    expect(ops.has('startElementPicker')).toBe(false);
  });

  it('advertises mutating-input verbs in supportedOperations once the CDP input transport is bound (BA-6)', () => {
    const adapter = createBrowserAutomationCdpAdapter({
      transport: transport({ dispatchInputCommand: vi.fn(async () => ({ ok: true as const })) }),
    });
    const ops = adapter.supportedOperations;
    expect(ops).toBeDefined();
    if (!ops) return;
    expect(ops.has('click')).toBe(true);
    expect(ops.has('type')).toBe(true);
    expect(ops.has('scroll')).toBe(true);
    expect(ops.has('setValue')).toBe(true);
    // Still never advertises verbs it cannot perform.
    expect(ops.has('evaluate')).toBe(false);
  });

  it('translates a navigate action into a navigate control command', async () => {
    const t = transport();
    const adapter = createBrowserAutomationCdpAdapter({ transport: t });

    const result = await adapter.execute(
      request({
        actionKind: 'navigate',
        payload: { url: 'https://browser.example.test/next' },
      }),
    );

    expect(result.status).toBe('succeeded');
    expect(result.fidelity).toBe('cdp');
    expect(t.dispatchControlCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
      }),
    );
  });

  it('translates a read-only snapshot action into a page query', async () => {
    const t = transport();
    const adapter = createBrowserAutomationCdpAdapter({ transport: t });

    const result = await adapter.execute(request({ actionKind: 'snapshot' }));

    expect(result.status).toBe('succeeded');
    expect(result.trustedInput).toBe(true);
    expect(t.dispatchPageQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        actionKind: 'snapshot',
      }),
    );
  });

  it('returns view_closed when the transport does not own the view', async () => {
    const adapter = createBrowserAutomationCdpAdapter({
      transport: transport({ ownsView: vi.fn(() => false) }),
    });

    const result = await adapter.execute(request({ actionKind: 'snapshot' }));

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('view_closed');
  });

  it('maps a failed control dispatch to a failed automation result with a runtime error code', async () => {
    const adapter = createBrowserAutomationCdpAdapter({
      transport: transport({
        dispatchControlCommand: vi.fn(async () => ({
          v: 1 as const,
          commandId: 'cmd',
          status: 'failed' as const,
          adapterKind: 'chromiumSidecar' as const,
          error: { code: 'adapter_unavailable' as const, message: 'CDP command failed.' },
        })),
      }),
    });

    const result = await adapter.execute(
      request({ actionKind: 'reload' }),
    );

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('runtime_unavailable');
  });

  it('returns unsupported_action for a mutating action with no CDP translation when no input transport exists', async () => {
    const adapter = createBrowserAutomationCdpAdapter({ transport: transport() });

    const result = await adapter.execute(
      request({ actionKind: 'startElementPicker' }),
    );

    expect(result.status).toBe('unsupported');
    expect(result.errorCode).toBe('unsupported_action');
  });

  // MCH-4: mutating non-navigation verbs route through the CDP input transport when present.
  it('routes a click verb through the CDP input transport (MCH-4)', async () => {
    const dispatchInputCommand = vi.fn(async () => ({ ok: true as const }));
    const adapter = createBrowserAutomationCdpAdapter({ transport: transport({ dispatchInputCommand }) });

    const result = await adapter.execute(
      request({ actionKind: 'click', payload: { selector: '#go' } }),
    );

    expect(result.status).toBe('succeeded');
    expect(result.fidelity).toBe('cdp');
    expect(result.trustedInput).toBe(false);
    expect(dispatchInputCommand).toHaveBeenCalledWith(
      expect.objectContaining({ actionKind: 'click', viewId: 'view_1' }),
    );
  });

  it('maps a failed CDP input dispatch to a failed automation result', async () => {
    const dispatchInputCommand = vi.fn(async () => ({ ok: false as const, errorCode: 'selector_not_found' as const }));
    const adapter = createBrowserAutomationCdpAdapter({ transport: transport({ dispatchInputCommand }) });

    const result = await adapter.execute(
      request({ actionKind: 'type', payload: { selector: '#x', text: 'hi' } }),
    );

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('selector_not_found');
  });
});
