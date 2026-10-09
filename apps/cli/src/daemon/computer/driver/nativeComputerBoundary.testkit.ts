import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, vi } from 'vitest';

const native = vi.hoisted(() => ({ instances: [] as Array<{
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  parameters: { command: string; args?: string[]; env?: Record<string, string> };
}>, tools: [] as Array<{ name: string; arguments: Record<string, unknown> }>, call: vi.fn(), close: vi.fn(), initialize: vi.fn() }));

export { native };

// The subprocess/MCP transport is the system boundary; adapter parsing and admission stay real.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({ PATH: '/fixture/bin' }),
  StdioClientTransport: class {
    onmessage?: (message: JSONRPCMessage) => void;
    onclose?: () => void;
    close = vi.fn(async () => { await native.close(this); });
    start = vi.fn(async () => {});
    send = vi.fn(async (message: JSONRPCMessage) => {
      if (!('id' in message) || !('method' in message)) return;
      if (message.method === 'initialize') {
        this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: await native.initialize(this) });
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

export const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
export const png = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABk';
export function captureResult() {
  return { content: [{ type: 'image', mimeType: 'image/png', data: png }], structuredContent: {
    pid: 42, window_id: 123, capture_id: 'capture-1', screenshot_width: 200, screenshot_height: 100,
    window_bounds: { x: -20, y: 30, width: 400, height: 300 }, screenshot_frame_valid: true,
    elements_complete: false, degraded_reason: 'x11_property_fallback_partial',
    elements: [{ element_index: 0, role: 'button', label: 'Apply', frame: { x: 2, y: 3, w: 20, h: 10 } }],
  } };
}

beforeEach(() => { native.instances.length = 0; native.tools.length = 0; native.call.mockReset();
  native.initialize.mockReset().mockResolvedValue({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: '0.31.0' } });
  native.close.mockReset().mockImplementation(async (transport: { onclose?: () => void }) => { transport.onclose?.(); }); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
