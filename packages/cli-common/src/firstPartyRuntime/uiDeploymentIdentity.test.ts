import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeUiDeploymentDigest, resolveUiDeploymentIdentity } from './uiDeploymentIdentity.js';

describe('resolveUiDeploymentIdentity', () => {
  it('retains the opaque deployment id only while the full managed UI payload is unchanged', async () => {
    const uiDir = await mkdtemp(join(tmpdir(), 'happier-ui-deployment-identity-'));
    await mkdir(join(uiDir, 'assets'), { recursive: true });
    await writeFile(join(uiDir, 'index.html'), '<script src="/assets/index.js"></script>', 'utf8');
    await writeFile(join(uiDir, 'assets', 'index.js'), 'console.log("same index reference")', 'utf8');
    await writeFile(join(uiDir, 'canvaskit.wasm'), 'wasm-a');
    try {
      const firstDigest = await computeUiDeploymentDigest(uiDir);
      const first = resolveUiDeploymentIdentity({
        digest: firstDigest,
        previousStateText: null,
        generateId: () => 'deployment_A_123456',
      });
      expect(first.deploymentId).toBe('deployment_A_123456');

      expect(resolveUiDeploymentIdentity({
        digest: await computeUiDeploymentDigest(uiDir),
        previousStateText: JSON.stringify({
          uiDeploymentDigest: first.digest,
          uiDeploymentId: first.deploymentId,
        }),
        generateId: () => 'deployment_B_123456',
      })).toEqual(first);

      await writeFile(join(uiDir, 'canvaskit.wasm'), 'wasm-b');
      expect(resolveUiDeploymentIdentity({
        digest: await computeUiDeploymentDigest(uiDir),
        previousStateText: JSON.stringify({
          uiDeploymentDigest: first.digest,
          uiDeploymentId: first.deploymentId,
        }),
        generateId: () => 'deployment_B_123456',
      }).deploymentId).toBe('deployment_B_123456');
    } finally {
      await rm(uiDir, { recursive: true, force: true });
    }
  });

  it('does not reuse malformed or version-like previous identifiers', () => {
    const result = resolveUiDeploymentIdentity({
      digest: `sha256:${'a'.repeat(64)}`,
      previousStateText: JSON.stringify({
        uiDeploymentDigest: 'sha256:not-a-real-digest',
        uiDeploymentId: 'version=0.2.10',
      }),
      generateId: () => 'deployment_C_123456',
    });
    expect(result.deploymentId).toBe('deployment_C_123456');
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
