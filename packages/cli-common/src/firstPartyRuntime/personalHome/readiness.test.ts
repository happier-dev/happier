import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parsePersonalHomeAuthenticatedReadiness,
  readPersonalHomeStartupReadiness,
  removePersonalHomeStartupReadiness,
} from './readiness.js';

describe('Personal Home startup readiness', () => {
  it('keeps predecessor readiness receipts readable while preserving current H6 setup state', () => {
    expect(parsePersonalHomeAuthenticatedReadiness({
      authenticated: true,
      homeServerIdentityId: 'srv_home_readiness',
      accountCount: 1,
      sessionCount: 0,
    })).toEqual({
      authenticated: true,
      homeServerIdentityId: 'srv_home_readiness',
      accountCount: 1,
      sessionCount: 0,
    });
  });

  it.each(['setup_required', 'teams_unavailable'])('reads a live authenticated Home attestation with Teams status %s', async (teamsBootstrapStatus) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-readiness-'));
    const path = join(root, 'startup-receipt.json');
    try {
      await writeFile(path, `${JSON.stringify({
        nonce: 'activation-nonce',
        pid: process.pid,
        host: '127.0.0.1',
        port: 43123,
        personalHomeReadiness: {
          authenticated: true,
          homeServerIdentityId: 'srv_home_readiness',
          accountCount: 2,
          sessionCount: 3,
          teamsBootstrapStatus,
        },
      })}\n`);

      await expect(readPersonalHomeStartupReadiness({ path, timeoutMs: 10 })).resolves.toEqual({
        authenticated: true,
        homeServerIdentityId: 'srv_home_readiness',
        accountCount: 2,
        sessionCount: 3,
        teamsBootstrapStatus,
      });
      await removePersonalHomeStartupReadiness(path);
      await expect(readPersonalHomeStartupReadiness({ path, timeoutMs: 10 })).rejects.toThrow(
        'authenticated readiness attestation did not arrive',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed, implausible, or dead-process readiness facts', async () => {
    expect(parsePersonalHomeAuthenticatedReadiness({
      authenticated: true,
      homeServerIdentityId: 'srv_home_readiness',
      accountCount: 1,
      sessionCount: 0,
      teamsBootstrapStatus: 'failed',
    })).toBeNull();

    const root = await mkdtemp(join(tmpdir(), 'happier-home-readiness-invalid-'));
    const path = join(root, 'startup-receipt.json');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(path, `${JSON.stringify({
        nonce: 'activation-nonce',
        pid: 2_147_483_647,
        host: '127.0.0.1',
        port: 43123,
        personalHomeReadiness: {
          authenticated: true,
          homeServerIdentityId: 'srv_home_readiness',
          accountCount: 0,
          sessionCount: 0,
        },
      })}\n`);
      await expect(readPersonalHomeStartupReadiness({ path, timeoutMs: 10 })).rejects.toThrow(
        'authenticated readiness attestation did not arrive',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
