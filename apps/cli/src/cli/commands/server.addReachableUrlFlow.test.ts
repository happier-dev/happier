import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { reloadConfiguration } from '@/configuration';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

let promptAnswers: string[] = [];
let promptQuestions: string[] = [];

// Terminal input is an OS boundary; its actual event lifecycle remains available
// to the canonical prompt owner instead of replacing that owner's cancellation.
vi.mock('node:readline', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...await importOriginal<typeof import('node:readline')>(),
    createInterface: () => {
      const input = new EventEmitter();
      return Object.assign(input, {
        question: (prompt: string, cb: (answer: string) => void) => {
          promptQuestions.push(prompt);
          cb(promptAnswers.shift() ?? '');
        },
        close: () => input.emit('close'),
      });
    },
  };
});

const runTailscaleServeStatusMock = vi.fn<
  (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) => Promise<string>
>();

vi.mock('@/integrations/tailscale/tailscaleCommand', () => ({
  runTailscaleServeStatus: (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) =>
    runTailscaleServeStatusMock(params),
}));

import { handleServerCommand } from './server';

describe('happier server add reachable URL flow', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));
  });

  afterEach(() => {
    promptAnswers = [];
    promptQuestions = [];
    runTailscaleServeStatusMock.mockReset();
    vi.restoreAllMocks();
  });

  it('offers detected reachable relay addresses when the interactive server URL is local-only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-guided-reachable-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const restoreTty = setStdioTtyForTest({ stdin: true, stdout: true });
    // The version probe uses the real loopback HTTP transport, not fetch.
    const relay = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/health') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: 'fixture-relay' }));
    });

    try {
      await new Promise<void>((ready, reject) => {
        relay.once('error', reject);
        relay.listen(0, '127.0.0.1', ready);
      });
      const address = relay.address();
      if (!address || typeof address === 'string') throw new Error('Missing relay fixture address');
      const localRelayUrl = `http://127.0.0.1:${address.port}`;
      promptAnswers = [localRelayUrl, 'y', '1', 'Local', 'n'];
      runTailscaleServeStatusMock.mockResolvedValueOnce([
        'https://my-machine.tailnet.ts.net',
        `|-- / proxy ${localRelayUrl}`,
        '',
      ].join('\n'));
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleServerCommand(['add']);
      } finally {
        output.restore();
      }

      const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
      expect(raw?.servers?.Local?.serverUrl).toBe('https://my-machine.tailnet.ts.net');
      expect(raw?.servers?.Local?.localServerUrl).toBe(localRelayUrl);
      expect(promptQuestions.join('\n')).toContain('reach this computer');
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      if (relay.listening) {
        await new Promise<void>((closed, reject) => relay.close((error) => error ? reject(error) : closed()));
      }
      await rm(home, { recursive: true, force: true });
    }
  });
});
