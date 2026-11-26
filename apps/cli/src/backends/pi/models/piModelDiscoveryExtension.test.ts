import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT } from '../sharedControl/piSharedControlProtocol';
import { buildPiModelDiscoveryExtensionSource, parsePiModelDiscoveryLine } from './piModelDiscoveryExtension';

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

// The Pi process API is the substituted boundary: a fake `pi` with Pi's event bus shape and a
// model registry returning a fresh refresh receipt. The generated discovery source runs for real.
async function runDiscovery(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'happier-pi-discovery-'));
  try {
    const file = join(dir, 'discovery.mjs');
    writeFileSync(file, buildPiModelDiscoveryExtensionSource({}));
    const mod = await import(`${pathToFileURL(file).href}?nonce=${Math.random()}`);
    const handlers = new Map<string, Handler[]>();
    const bus = new EventEmitter();
    const busLines: unknown[] = [];
    bus.on(PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT, (line: unknown) => busLines.push(line));
    const model = { id: 'grok-4.7', provider: 'xai', name: 'Grok 4.7', reasoning: true };
    const ctx = {
      mode,
      modelRegistry: {
        getAll: () => [model],
        hasConfiguredAuth: () => true,
        refresh: async () => ({ aborted: false, errors: new Map() }),
        getError: () => undefined,
        getAvailable: () => [model],
      },
    };
    (mod.default as (pi: unknown) => void)({
      on: (event: string, handler: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
      events: { emit: (channel: string, data: unknown) => { bus.emit(channel, data); }, on: () => () => undefined },
    });
    for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx);
    return busLines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Pi model discovery extension sink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('publishes on the Pi event bus in TUI mode and never writes to the terminal', async () => {
    vi.stubEnv('PI_OFFLINE', '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const busLines = await runDiscovery('tui');
    expect(stderr).not.toHaveBeenCalled();
    expect(busLines).toHaveLength(1);
    expect(parsePiModelDiscoveryLine(String(busLines[0]))).toEqual({
      models: [{ id: 'grok-4.7', provider: 'xai', name: 'Grok 4.7', reasoning: true }],
    });
  });

  it('keeps the stderr marker in RPC and JSON modes, which the RPC backend and preflight probe read', async () => {
    vi.stubEnv('PI_OFFLINE', '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const mode of ['rpc', 'json']) {
      stderr.mockClear();
      await expect(runDiscovery(mode)).resolves.toEqual([]);
      const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
      expect(lines, mode).toHaveLength(1);
      expect(parsePiModelDiscoveryLine(lines[0]!.trim()), mode).toMatchObject({ models: [{ id: 'grok-4.7' }] });
    }
  });
});
