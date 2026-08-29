import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { handlePluginsCommand } from './plugins';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const sessionAgentExampleRoot = join(repositoryRoot, 'packages', 'plugin-sdk', 'examples', 'session-agent');

describe('plugins create Session Agent copy canary', () => {
  it('turns one actual CLI scaffold into the maintained Session Agent copy shape in a temp directory', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-session-agent-copy-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(parentDir);
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['create', 'my-session-agent', '--json']);
        expect(output.json()).toMatchObject({ ok: true, kind: 'plugins_create' });
      } finally {
        output.restore();
      }

      const targetRoot = join(parentDir, 'my-session-agent');
      const generatedTest = await readFile(join(targetRoot, 'test', 'index.test.mjs'), 'utf8');
      expect(generatedTest).toContain("invokeAction('save-note'");

      await mkdir(join(targetRoot, 'src', 'agent'), { recursive: true });
      await Promise.all([
        writeFile(
          join(targetRoot, 'src', 'index.ts'),
          await readFile(join(sessionAgentExampleRoot, 'index.ts'), 'utf8'),
        ),
        writeFile(
          join(targetRoot, 'src', 'agent', 'deterministicSessionAgent.ts'),
          await readFile(join(sessionAgentExampleRoot, 'agent', 'deterministicSessionAgent.ts'), 'utf8'),
        ),
        writeFile(
          join(targetRoot, 'test', 'index.test.mjs'),
          await readFile(join(sessionAgentExampleRoot, 'test', 'index.test.mjs'), 'utf8'),
        ),
      ]);

      const replacementTest = await readFile(join(targetRoot, 'test', 'index.test.mjs'), 'utf8');
      expect(replacementTest).not.toContain('save-note');
      expect(replacementTest).toContain('sessionRunnerFactory');
      expect(await readFile(join(targetRoot, 'src', 'index.ts'), 'utf8'))
        .toContain('createDeterministicSessionAgentRuntime');
    } finally {
      process.chdir(previousCwd);
      await rm(parentDir, { recursive: true, force: true });
    }
  });
});
