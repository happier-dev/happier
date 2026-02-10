import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { enrichCapabilityProbeError } from '../../src/testkit/providers/harness/capabilityProbeFailure';

describe('providers: capability probe failure enrichment', () => {
  it('maps timeout errors to provider fatal error when logs include auth verification', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const logsDir = join(cliHome, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, '2026-02-09-11-18-27-pid-88389.log'),
      '[AcpBackend] Error sending prompt: {"code":403,"message":"Verify your account to continue."}\n',
      'utf8',
    );

    const enriched = await enrichCapabilityProbeError({
      error: new Error('operation has timed out'),
      cliHome,
      context: 'capabilities.invoke',
    });
    expect(enriched.message).toContain('Fatal provider runtime error');
    expect(enriched.message).toContain('Account verification required');
  });

  it('keeps the original error when no fatal provider signal exists', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const logsDir = join(cliHome, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'log.log'), '[AcpBackend] Session created\n', 'utf8');

    const original = new Error('operation has timed out');
    const enriched = await enrichCapabilityProbeError({
      error: original,
      cliHome,
      context: 'capabilities.invoke',
    });
    expect(enriched).toBe(original);
  });
});
