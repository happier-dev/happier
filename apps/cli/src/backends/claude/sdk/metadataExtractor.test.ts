import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPidToExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for PID ${pid} to exit`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

describe.sequential('claude sdk metadata extractor', () => {
  let tmpRoot = '';

  beforeEach(() => {
    vi.resetModules();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  it('aborts the claude process after capturing init metadata (no leak)', { timeout: 20_000 }, async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-metadata-extractor-init-'));
    const pidFile = join(tmpRoot, 'pid.txt');
    const fakeClaude = join(tmpRoot, 'fake-claude.js');
    writeFileSync(
      fakeClaude,
      `
        const { writeFileSync } = require('node:fs');
        const pidFile = ${JSON.stringify(pidFile)};
        writeFileSync(pidFile, String(process.pid), 'utf8');

        process.stdout.write(JSON.stringify({
          type: 'system',
          subtype: 'init',
          tools: ['tool-a'],
          slash_commands: ['/cmd'],
        }) + '\\n');

        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      `,
      'utf8',
    );

    await withEnv(
      {
        HAPPIER_CLAUDE_PATH: fakeClaude,
      },
      async () => {
        const { extractSDKMetadata } = await import('./metadataExtractor');
        const metadata = await withTimeout(extractSDKMetadata(), 2_000, 'extractSDKMetadata to resolve');
        expect(metadata).toEqual({ tools: ['tool-a'], slashCommands: ['/cmd'] });

        await waitForFile(pidFile, 1_000);
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        await waitForPidToExit(pid, 2_000);
      },
    );
  });

  it('respects a configurable extraction timeout and aborts on hang', { timeout: 20_000 }, async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-metadata-extractor-timeout-'));
    const pidFile = join(tmpRoot, 'pid.txt');
    const fakeClaude = join(tmpRoot, 'fake-claude.js');
    writeFileSync(
      fakeClaude,
      `
        const { writeFileSync } = require('node:fs');
        const pidFile = ${JSON.stringify(pidFile)};
        writeFileSync(pidFile, String(process.pid), 'utf8');
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      `,
      'utf8',
    );

    await withEnv(
      {
        HAPPIER_CLAUDE_PATH: fakeClaude,
        HAPPIER_CLAUDE_SDK_METADATA_EXTRACTION_TIMEOUT_MS: '75',
      },
      async () => {
        const { extractSDKMetadata } = await import('./metadataExtractor');
        const resultPromise = extractSDKMetadata();

        await waitForFile(pidFile, 1_000);
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);

        try {
          await expect(withTimeout(resultPromise, 750, 'extractSDKMetadata to timeout')).resolves.toEqual({});
        } finally {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // ignore
          }
          await waitForPidToExit(pid, 2_000);
        }
      },
    );
  });
});

