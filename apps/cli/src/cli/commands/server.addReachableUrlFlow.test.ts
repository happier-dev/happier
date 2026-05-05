import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

let promptAnswers: string[] = [];
let promptQuestions: string[] = [];

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (prompt: string, cb: (answer: string) => void) => {
      promptQuestions.push(prompt);
      cb(promptAnswers.shift() ?? '');
    },
    close: () => {},
  }),
}));

const runTailscaleServeStatusMock = vi.fn<
  (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) => Promise<string>
>();

vi.mock('@/integrations/tailscale/tailscaleCommand', () => ({
  runTailscaleServeStatus: (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) =>
    runTailscaleServeStatusMock(params),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: vi.fn(async () => ({ status: 'unavailable' })),
}));

import { handleServerCommand } from './server';

describe('happier server add reachable URL flow', () => {
  afterEach(() => {
    promptAnswers = [];
    promptQuestions = [];
    runTailscaleServeStatusMock.mockReset();
  });

  it('offers detected reachable relay addresses when the interactive server URL is local-only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-guided-reachable-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const restoreTty = setStdioTtyForTest({ stdin: true, stdout: true });
    promptAnswers = [
      'http://127.0.0.1:53545',
      'y',
      '1',
      'Local',
      'n',
    ];

    runTailscaleServeStatusMock.mockResolvedValueOnce(
      [
        'https://my-machine.tailnet.ts.net',
        '|-- / proxy http://127.0.0.1:53545',
        '',
      ].join('\n'),
    );

    try {
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
      expect(raw?.servers?.Local?.localServerUrl).toBe('http://127.0.0.1:53545');
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
      await rm(home, { recursive: true, force: true });
    }
  });
});
