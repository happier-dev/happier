import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBoundedTextFileAppender, createSubprocessStderrAppender } from './subprocessArtifacts';

describe('subprocessArtifacts', () => {
  it('returns null when HAPPIER_SUBPROCESS_STDERR_MAX_BYTES=0', async () => {
    const artifactsRoot = mkdtempSync(join(tmpdir(), 'happier-debug-artifacts-'));

    const prevRoot = process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
    const prevMax = process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES;

    try {
      process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = artifactsRoot;
      process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES = '0';

      const appender = await createSubprocessStderrAppender({ agentName: 'test', pid: 123, label: 'acp' });
      expect(appender).toBeNull();
    } finally {
      if (prevRoot === undefined) delete process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
      else process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = prevRoot;

      if (prevMax === undefined) delete process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES;
      else process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES = prevMax;

      rmSync(artifactsRoot, { recursive: true, force: true });
    }
  });

  it('truncates text when maxBytes is reached', async () => {
    const artifactsRoot = mkdtempSync(join(tmpdir(), 'happier-bounded-text-'));
    const filePath = join(artifactsRoot, 'stderr.log');

    try {
      const appender = await createBoundedTextFileAppender({ filePath, maxBytes: 5 });
      appender.append('hello');
      appender.append('world');
      await appender.close();

      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('hello');
      expect(content).toContain('...[truncated]');
    } finally {
      rmSync(artifactsRoot, { recursive: true, force: true });
    }
  });
});

