import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { readFatalProviderErrorFromCliLogs } from '../../src/testkit/providers/harness';

describe('providers harness: cli log fatal error detection', () => {
  it('detects authentication-required errors from cli logs', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const logsDir = join(cliHome, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, '2026-02-08-16-32-44-pid-12345.log'),
      '[AcpBackend] Error sending prompt: {"code":-32000,"message":"Authentication required","data":null}\n',
      'utf8',
    );

    await expect(readFatalProviderErrorFromCliLogs({ cliHome })).resolves.toContain('Authentication required');
  });

  it('detects out-of-credits errors from cli logs', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const logsDir = join(cliHome, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, '2026-02-08-20-04-03-pid-78519.log'),
      '[AcpBackend] Received message chunk (length: 168): ⚠️ You have run out of credits for this account\n',
      'utf8',
    );

    await expect(readFatalProviderErrorFromCliLogs({ cliHome })).resolves.toContain('Out of credits');
  });

  it('returns null when no fatal error is present', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const logsDir = join(cliHome, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'log.log'), '[AcpBackend] Session created\n', 'utf8');

    await expect(readFatalProviderErrorFromCliLogs({ cliHome })).resolves.toBeNull();
  });

  it('detects account-verification errors from cli logs', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const logsDir = join(cliHome, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, '2026-02-08-20-15-03-pid-88888.log'),
      '[AcpBackend] Error sending prompt: {"code":403,"message":"Verify your account to continue."}\n',
      'utf8',
    );

    await expect(readFatalProviderErrorFromCliLogs({ cliHome })).resolves.toContain('Account verification required');
  });

  it('detects prompt runtime failures from cli logs', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const logsDir = join(cliHome, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, '2026-02-09-14-13-12-pid-36813.log'),
      '[Kimi] Error during prompt: {}\n',
      'utf8',
    );

    await expect(readFatalProviderErrorFromCliLogs({ cliHome })).resolves.toContain('Prompt request failed');
  });
});
