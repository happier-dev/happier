import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';

import { native } from '@/daemon/computer/driver/nativeComputerBoundary.testkit';

// The subprocess/MCP transport is the system boundary; adapter parsing and admission stay real.
export const getDefaultEnvironment = () => ({ PATH: '/fixture/bin' });

export class StdioClientTransport {
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
  constructor(readonly parameters: { command: string; args?: string[]; env?: Record<string, string> }) {
    native.instances.push(this);
  }
}
