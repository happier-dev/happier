import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTailscaleCmd } from './ip.mjs';

test('resolveTailscaleCmd prefers the unified Tailscale env override', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-stack-tailscale-ip-'));
  const tailscaleBin = join(tempRoot, 'tailscale');

  try {
    writeFileSync(
      tailscaleBin,
      [
        '#!/usr/bin/env node',
        'process.exit(0);',
        '',
      ].join('\n'),
    );
    chmodSync(tailscaleBin, 0o755);

    const resolved = await resolveTailscaleCmd({
      env: {
        PATH: join(tempRoot, 'missing-path'),
        HOME: tempRoot,
        HAPPIER_TAILSCALE_BIN: tailscaleBin,
        HAPPIER_STACK_TAILSCALE_BIN: '/legacy/ignored-tail-scale',
      },
    });

    assert.equal(resolved, tailscaleBin);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
