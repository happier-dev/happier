import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { cliCapability as kiloCliCapability } from './capability';

type DetectArgs = Parameters<NonNullable<typeof kiloCliCapability.detect>>[0];

function makeUnavailableCliEntry() {
  return { available: false, resolvedPath: undefined };
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
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

describe('cli.kilo capability (ACP)', () => {
  it('detects session/load support via a deterministic ACP shim binary', async () => {
    const require = createRequire(import.meta.url);
    const acpModulePath = require.resolve('@agentclientprotocol/sdk/dist/acp.js');
    const acpModuleUrl = pathToFileURL(acpModulePath).href;

    const workDir = makeTempDir('happier-kilo-acp-probe-');
    try {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });

      const agentPath = join(binDir, 'acp-agent.mjs');
      writeFileSync(
        agentPath,
        [
          `import * as acp from ${JSON.stringify(acpModuleUrl)};`,
          'import { Readable, Writable } from "node:stream";',
          '',
          'class ProbeAgent {',
          '  async initialize() {',
          '    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } };',
          '  }',
          '}',
          '',
          'const input = Writable.toWeb(process.stdout);',
          'const output = Readable.toWeb(process.stdin);',
          'const stream = acp.ndJsonStream(input, output);',
          'new acp.AgentSideConnection(() => new ProbeAgent(), stream);',
          '',
        ].join('\n'),
        'utf8',
      );

      const resolvedPath =
        process.platform === 'win32'
          ? makeWindowsCmdExecutable({
              dir: binDir,
              name: 'kilo',
              content: ['@echo off', 'node "%~dp0acp-agent.mjs" %*', ''].join('\r\n'),
            })
          : makeUnixExecutable({
              dir: binDir,
              name: 'kilo',
              content: ['#!/bin/sh', 'set -e', 'DIR="$(cd "$(dirname "$0")" && pwd)"', 'exec node "$DIR/acp-agent.mjs" "$@"', ''].join('\n'),
            });

      const request: DetectArgs['request'] = { id: 'cli.kilo', params: { includeAcpCapabilities: true } };
      const context: DetectArgs['context'] = {
        cliSnapshot: {
          path: process.env.PATH ?? null,
          clis: {
            claude: makeUnavailableCliEntry(),
            codex: makeUnavailableCliEntry(),
            opencode: makeUnavailableCliEntry(),
            gemini: makeUnavailableCliEntry(),
            auggie: makeUnavailableCliEntry(),
            qwen: makeUnavailableCliEntry(),
            kimi: makeUnavailableCliEntry(),
            kilo: { available: true, resolvedPath },
            pi: makeUnavailableCliEntry(),
            copilot: makeUnavailableCliEntry(),
          },
          tmux: { available: false },
        },
      };

      const res = await kiloCliCapability.detect({ request, context }) as {
        available: boolean;
        resolvedPath: string | null;
        acp?: { ok: boolean; loadSession?: boolean };
      };
      expect(res.available).toBe(true);
      expect(res.resolvedPath).toBe(resolvedPath);
      expect(res.acp?.ok).toBe(true);
      expect(res.acp?.loadSession).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});
