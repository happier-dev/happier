import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cliCapability as geminiCliCapability } from './capability';
import type { DetectCliEntry, DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';

type DetectArgs = Parameters<typeof geminiCliCapability.detect>[0];

function makeUnavailableCliEntry(): DetectCliEntry {
  return { available: false, resolvedPath: undefined };
}

function makeUnixExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, params.name);
  writeFileSync(filePath, params.content, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

function makeWindowsCmdExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, `${params.name}.cmd`);
  writeFileSync(filePath, params.content, 'utf8');
  return filePath;
}

describe('cli.gemini capability ACP probe args', () => {
  it('launches the Gemini ACP capability probe with --acp', async () => {
    const previousProbeTimeout = process.env.HAPPIER_ACP_PROBE_TIMEOUT_GEMINI_MS;
    process.env.HAPPIER_ACP_PROBE_TIMEOUT_GEMINI_MS = '2000';

    const workDir = mkdtempSync(join(tmpdir(), 'happier-gemini-acp-capability-'));
    try {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argvLogPath = join(workDir, 'argv.json');

      const agentPath = join(binDir, 'acp-agent.mjs');
      writeFileSync(
        agentPath,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(argvLogPath)}, JSON.stringify(process.argv.slice(2)));`,
          'process.exit(0);',
        ].join('\n'),
        'utf8',
      );

      const resolvedPath = process.platform === 'win32'
        ? makeWindowsCmdExecutable({
          dir: binDir,
          name: 'gemini',
          content: ['@echo off', 'node "%~dp0acp-agent.mjs" %*', ''].join('\r\n'),
        })
        : makeUnixExecutable({
          dir: binDir,
          name: 'gemini',
          content: ['#!/bin/sh', 'set -e', 'DIR="$(cd "$(dirname "$0")" && pwd)"', 'exec node "$DIR/acp-agent.mjs" "$@"', ''].join('\n'),
        });

      const request: DetectArgs['request'] = { id: 'cli.gemini', params: { includeAcpCapabilities: true } };
      const context: DetectArgs['context'] = {
        cliSnapshot: {
          path: process.env.PATH ?? null,
          clis: {
            claude: makeUnavailableCliEntry(),
            codex: makeUnavailableCliEntry(),
            opencode: makeUnavailableCliEntry(),
            gemini: { available: true, resolvedPath },
            auggie: makeUnavailableCliEntry(),
            qwen: makeUnavailableCliEntry(),
            kimi: makeUnavailableCliEntry(),
            kilo: makeUnavailableCliEntry(),
            kiro: makeUnavailableCliEntry(),
            customAcp: makeUnavailableCliEntry(),
            ohMyPi: makeUnavailableCliEntry(),
            pi: makeUnavailableCliEntry(),
            cursor: makeUnavailableCliEntry(),
            copilot: makeUnavailableCliEntry(),
          },
          tmux: { available: false },
          windowsTerminal: { available: false },
        } satisfies DetectCliSnapshot,
      };

      await geminiCliCapability.detect({ request, context });

      expect(JSON.parse(readFileSync(argvLogPath, 'utf8'))).toEqual(['--acp']);
    } finally {
      if (previousProbeTimeout === undefined) {
        delete process.env.HAPPIER_ACP_PROBE_TIMEOUT_GEMINI_MS;
      } else {
        process.env.HAPPIER_ACP_PROBE_TIMEOUT_GEMINI_MS = previousProbeTimeout;
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});
