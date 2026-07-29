import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeComposeServerImageFingerprint } from './computeComposeServerImageFingerprint';

function createMinimalRepoRoot(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-stress-fingerprint-'));

  mkdirSync(join(repoRoot, '.github/feature-policy'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps/server'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps/stack/scripts/utils'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/agents'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/cli-common'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/protocol'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/plugin-sdk'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/plugins/review-coderabbit'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/plugins/review-deepsec'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/release-runtime'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/tests/src/testkit/stress/targets'), { recursive: true });
  mkdirSync(join(repoRoot, 'scripts/ci'), { recursive: true });
  mkdirSync(join(repoRoot, 'scripts/pipeline/expo'), { recursive: true });

  writeFileSync(join(repoRoot, '.dockerignore'), 'node_modules\n', 'utf8');
  writeFileSync(join(repoRoot, '.github/feature-policy/production.json'), '{"features":{}}\n', 'utf8');
  writeFileSync(join(repoRoot, 'Dockerfile'), 'FROM node:22\n', 'utf8');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: [] }), 'utf8');
  writeFileSync(join(repoRoot, 'yarn.lock'), '', 'utf8');
  writeFileSync(join(repoRoot, 'apps/server/package.json'), JSON.stringify({ name: 'server' }), 'utf8');
  writeFileSync(join(repoRoot, 'apps/server/index.ts'), 'export const server = true;\n', 'utf8');
  writeFileSync(join(repoRoot, 'apps/stack/scripts/utils/owner.mjs'), 'export const owner = true;\n', 'utf8');
  writeFileSync(join(repoRoot, 'packages/agents/package.json'), JSON.stringify({ name: 'agents' }), 'utf8');
  writeFileSync(join(repoRoot, 'packages/cli-common/package.json'), JSON.stringify({ name: 'cli-common' }), 'utf8');
  writeFileSync(join(repoRoot, 'packages/protocol/package.json'), JSON.stringify({ name: 'protocol' }), 'utf8');
  writeFileSync(join(repoRoot, 'packages/plugin-sdk/package.json'), JSON.stringify({ name: 'plugin-sdk' }), 'utf8');
  writeFileSync(join(repoRoot, 'packages/plugin-sdk/index.ts'), 'export const sdk = true;\n', 'utf8');
  writeFileSync(join(repoRoot, 'packages/plugins/review-coderabbit/package.json'), JSON.stringify({ name: 'review-coderabbit' }), 'utf8');
  writeFileSync(join(repoRoot, 'packages/plugins/review-deepsec/package.json'), JSON.stringify({ name: 'review-deepsec' }), 'utf8');
  writeFileSync(join(repoRoot, 'packages/release-runtime/package.json'), JSON.stringify({ name: 'release-runtime' }), 'utf8');
  writeFileSync(
    join(repoRoot, 'packages/tests/src/testkit/stress/targets/startFullComposeStressTarget.ts'),
    'export const generatedDockerfileContract = "v1";\n',
    'utf8',
  );
  writeFileSync(join(repoRoot, 'scripts/pipeline/expo/eas-postinstall.mjs'), 'export {};\n', 'utf8');
  writeFileSync(join(repoRoot, 'scripts/ci/unused.sh'), 'echo hi\n', 'utf8');

  return repoRoot;
}

describe('computeComposeServerImageFingerprint', () => {
  it('ignores stress-unrelated scripts/ci churn but changes when server runtime inputs change', () => {
    const repoRoot = createMinimalRepoRoot();

    const initial = computeComposeServerImageFingerprint(repoRoot);

    writeFileSync(join(repoRoot, 'scripts/ci/unused.sh'), 'echo changed\n', 'utf8');
    const afterIgnoredChange = computeComposeServerImageFingerprint(repoRoot);

    writeFileSync(join(repoRoot, 'apps/server/index.ts'), 'export const server = false;\n', 'utf8');
    const afterServerChange = computeComposeServerImageFingerprint(repoRoot);

    expect(afterIgnoredChange).toBe(initial);
    expect(afterServerChange).not.toBe(initial);
  });

  it('ignores atomic workspace build staging and recovery directories', () => {
    const repoRoot = createMinimalRepoRoot();
    const initial = computeComposeServerImageFingerprint(repoRoot);
    const generatedOutputDirs = [
      '.dist.build.123',
      '.dist.hstack-stage-abc',
      '.restore.123',
      '.tmp.123',
    ];

    for (const directoryName of generatedOutputDirs) {
      const outputDir = join(repoRoot, 'packages/protocol', directoryName);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, 'generated.js'), 'export const generated = true;\n', 'utf8');
    }

    expect(computeComposeServerImageFingerprint(repoRoot)).toBe(initial);
  });

  it('changes when the generated server Dockerfile contract changes', () => {
    const repoRoot = createMinimalRepoRoot();
    const generatorPath = join(
      repoRoot,
      'packages/tests/src/testkit/stress/targets/startFullComposeStressTarget.ts',
    );

    const initial = computeComposeServerImageFingerprint(repoRoot);
    writeFileSync(generatorPath, 'export const generatedDockerfileContract = "v2";\n', 'utf8');

    expect(computeComposeServerImageFingerprint(repoRoot)).not.toBe(initial);
  });

  it('changes when the canonical server workspace build closure changes', () => {
    const repoRoot = createMinimalRepoRoot();
    const initial = computeComposeServerImageFingerprint(repoRoot);

    writeFileSync(
      join(repoRoot, 'packages/plugin-sdk/index.ts'),
      'export const sdk = false;\n',
      'utf8',
    );

    expect(computeComposeServerImageFingerprint(repoRoot)).not.toBe(initial);
  });

  it('changes when the embedded feature policy changes', () => {
    const repoRoot = createMinimalRepoRoot();
    const initial = computeComposeServerImageFingerprint(repoRoot);

    writeFileSync(
      join(repoRoot, '.github/feature-policy/production.json'),
      '{"features":{"voice":{"enabled":true}}}\n',
      'utf8',
    );

    expect(computeComposeServerImageFingerprint(repoRoot)).not.toBe(initial);
  });
});
