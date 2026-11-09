import { expect, it } from 'vitest';
import { cleanupBackendRunResources } from './cleanupBackendRunResources';

it('retires the Session MCP endpoint before releasing runtime resources', async () => {
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const cleanup = cleanupBackendRunResources({ stopKeepAlive: () => undefined,
    stopMcpServer: async () => { order.push('mcp:start'); await stopped; order.push('mcp:end'); },
    resetRuntime: async () => { order.push('runtime'); }, unmountUi: () => undefined });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual(['mcp:start']);
  } finally { release(); await cleanup; }
  expect(order).toEqual(['mcp:start', 'mcp:end', 'runtime']);
});

it('does not finish cleanup before the terminal UI has released its resources', async () => {
  const order: string[] = [];
  let releaseUi!: () => void;
  const uiReleased = new Promise<void>(resolve => { releaseUi = resolve; });
  let finished = false;
  const cleanup = cleanupBackendRunResources({
    stopKeepAlive: () => { order.push('keepAlive'); },
    reconnectionHandle: { cancel: () => { order.push('reconnection'); } },
    stopMcpServer: () => { order.push('mcp'); },
    resetRuntime: async () => { order.push('runtime'); },
    unmountUi: async () => {
      order.push('ui:start');
      await uiReleased;
      order.push('ui:end');
    },
  }).then(() => { finished = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual(['keepAlive', 'reconnection', 'mcp', 'runtime', 'ui:start']);
    expect(finished).toBe(false);
  } finally {
    releaseUi();
    await cleanup;
  }
  expect(order.at(-1)).toBe('ui:end');
  expect(finished).toBe(true);
});
