import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, vi } from 'vitest';
import { COMPUTER_CUA_DRIVER_VERSION } from '@happier-dev/protocol/installables';

const native = vi.hoisted(() => ({ instances: [] as Array<{
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  parameters: { command: string; args?: string[]; env?: Record<string, string> };
}>, tools: [] as Array<{ name: string; arguments: Record<string, unknown> }>, call: vi.fn(), close: vi.fn(), initialize: vi.fn() }));

export { native };

// A redirect mock preserves simultaneous native connections. Vitest's manual
// factory mock shares its import callstack and can bypass the fake for one import.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js');

export const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
export const png = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABk';
// Captured Cua 0.37.0 Linux refusal: native-typing-live-red.log. There is
// no effect/status proof that earlier accessibility attempts did nothing.
export function backgroundTextRefusalResult() {
  return { isError: true, structuredContent: {
    code: 'background_unavailable',
    detail: 'the requested target has no focus-free input backend; the remaining input route can only deliver to the globally focused widget',
    escalation: { reason: 'background input is unavailable on this surface', recommended: 'foreground' },
    hint: 'Xvfb/Xtigervnc cannot hot-add input devices, so the route is unavailable there.',
    next_call: { arguments: { pid: target.pid, window_id: target.windowId }, tool: 'get_window_state' },
  } };
}
export function captureResult() {
  return { content: [{ type: 'image', mimeType: 'image/png', data: png }], structuredContent: {
    pid: 42, window_id: 123, capture_id: 'capture-1', screenshot_width: 200, screenshot_height: 100,
    window_bounds: { x: -20, y: 30, width: 400, height: 300 }, screenshot_frame_valid: true,
    elements_complete: false, degraded_reason: 'x11_property_fallback_partial',
    elements: [{ element_index: 0, role: 'button', label: 'Apply', frame: { x: 2, y: 3, w: 20, h: 10 } }],
  } };
}

beforeEach(() => {
  native.instances.length = 0; native.tools.length = 0; native.call.mockReset();
  native.initialize.mockReset().mockResolvedValue({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: COMPUTER_CUA_DRIVER_VERSION } });
  native.close.mockReset().mockImplementation(async (transport: { onclose?: () => void }) => { transport.onclose?.(); }); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
