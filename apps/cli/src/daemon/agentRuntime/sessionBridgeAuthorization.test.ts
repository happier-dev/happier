import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentRuntimeSessionBridgeAuthorization,
  hashAgentRuntimeSessionBridgeToken,
  verifyAgentRuntimeSessionBridgeToken,
} from './sessionBridgeAuthorization';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('Agent runtime session bridge authorization', () => {
  it('mints a distinct file-only token bound to the immutable Agent identity', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-bridge-auth-'));
    roots.push(happyHomeDir);
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-7',
      immutableGenerationId: 'sha256:abc',
      factoryControls: {
        continuation: true,
        goals: true,
        catalog: true,
        usageLimitRecovery: true,
      },
    };
    const issued = await createAgentRuntimeSessionBridgeAuthorization({
      happyHomeDir,
      publicReleaseRing: 'stable',
      token: 'secret-token',
      descriptor,
    });

    expect(issued.authorization).toMatchObject({
      tokenHash: hashAgentRuntimeSessionBridgeToken('secret-token'),
      descriptor,
    });
    expect(issued.childEnv).toEqual({
      HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE:
        issued.authorization.tokenFilePath,
    });
    expect(JSON.parse(await readFile(
      issued.authorization.tokenFilePath,
      'utf8',
    ))).toEqual({
      v: 1,
      token: 'secret-token',
      descriptor,
    });
    if (process.platform !== 'win32') {
      expect((await stat(issued.authorization.tokenFilePath)).mode & 0o777)
        .toBe(0o600);
    }

    await issued.cleanupTokenFile();
    await expect(stat(issued.authorization.tokenFilePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('verifies only the exact token against a canonical digest', () => {
    const expectedTokenHash = hashAgentRuntimeSessionBridgeToken('secret-token');
    expect(verifyAgentRuntimeSessionBridgeToken({
      providedToken: 'secret-token',
      expectedTokenHash,
    })).toBe(true);
    expect(verifyAgentRuntimeSessionBridgeToken({
      providedToken: 'secret-token-2',
      expectedTokenHash,
    })).toBe(false);
    expect(verifyAgentRuntimeSessionBridgeToken({
      providedToken: 'secret-token',
      expectedTokenHash: 'sha256:not-a-digest',
    })).toBe(false);
  });
});
