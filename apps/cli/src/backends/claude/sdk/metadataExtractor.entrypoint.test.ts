import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('applies Happier attribution to metadata probes and isolates cached catalogs by attribution', async () => {
  root = await mkdtemp(join(tmpdir(), 'happier-claude-metadata-entrypoint-'));
  const configDir = join(root, 'claude');
  const claudePath = join(root, 'claude.cjs');
  await mkdir(configDir);
  // External Claude process fixture: exercise the real extractor, query and environment owner.
  await writeFile(claudePath, `
    if (process.argv.includes('--version')) {
      process.stdout.write('claude fixture-entrypoint\\n');
    } else {
      process.stdout.write(JSON.stringify({
        type: 'system', subtype: 'init', session_id: 'metadata-fixture',
        tools: [process.env.CLAUDE_CODE_ENTRYPOINT || 'default', process.env.CLAUDECODE || 'clean'],
        slash_commands: ['/help']
      }) + '\\n');
      if (!process.argv.includes('--no-session-persistence')) {
        require('node:fs').writeFileSync(require('node:path').join(process.env.CLAUDE_CONFIG_DIR, 'probe.jsonl'), 'hello');
      }
    }
  `);
  vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'happier'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  vi.stubEnv('HAPPIER_CLAUDE_PATH', claudePath);
  vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'sdk-ts');
  vi.stubEnv('CLAUDECODE', '1');
  vi.resetModules();
  const { extractSDKMetadata } = await import('./metadataExtractor');
  expect(await extractSDKMetadata()).toMatchObject({ tools: ['happier', 'clean'] });
  expect(await extractSDKMetadata({ claudeCodeIncludeInNativeHistory: true })).toMatchObject({ tools: ['happier', 'clean'] });
  expect(await extractSDKMetadata({ claudeCodeIncludeInNativeHistory: false })).toMatchObject({ tools: ['default', 'clean'] });
  expect(await import('node:fs/promises').then(fs => fs.readdir(configDir))).not.toContain('probe.jsonl');
});

it.each([true, false])('retains only captured metadata when the owned probe fails (init received: %s)', async (emitInit) => {
  root = await mkdtemp(join(tmpdir(), 'happier-claude-metadata-cleanup-'));
  const configDir = join(root, 'claude');
  const projectDir = join(root, 'project');
  const claudePath = join(root, 'claude.cjs');
  const pidPath = join(root, 'provider-pid');
  await mkdir(configDir);
  await mkdir(projectDir);
  await writeFile(claudePath, `
    if (process.argv.includes('--version')) {
      process.stdout.write('claude fixture-cleanup\\n');
    } else {
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      if (${emitInit}) {
        process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'metadata-fixture',
          tools: ['read'], slash_commands: ['/help'] }) + '\\n');
        setInterval(() => {}, 1000);
      } else {
        process.exit(7);
      }
    }
  `);
  vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'happier'));
  vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  vi.stubEnv('HAPPIER_CLAUDE_PATH', claudePath);
  vi.stubEnv('HAPPIER_CLAUDE_SDK_METADATA_CACHE_INVALIDATE', '0');
  const originalCwd = process.cwd();
  process.chdir(projectDir);
  vi.resetModules();
  const { extractSDKMetadata } = await import('./metadataExtractor');
  const { logger } = await import('@/ui/logger');
  const signal = process.kill.bind(process);
  const childKill = ChildProcess.prototype.kill;
  const ownedPid = (): number | undefined => existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : undefined;
  // Genuine OS termination rejection, restricted to the process that emitted this fixture's init.
  const deniedSignal = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
    if (emitInit && pid === ownedPid() && requestedSignal !== 0) {
      throw Object.assign(new Error('fixture-signal-denied'), { code: 'EPERM' });
    }
    return signal(pid, requestedSignal);
  });
  const deniedChildKill = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (this: ChildProcess, requestedSignal) {
    if (emitInit && this.pid === ownedPid()) return false;
    return childKill.call(this, requestedSignal);
  });
  try {
    const metadata = await extractSDKMetadata();
    if (emitInit) {
      logger.flushSync();
      expect(readFileSync(logger.logFilePath, 'utf8')).toContain('process_tree_termination_incomplete');
    }
    expect(metadata).toEqual(emitInit ? { tools: ['read'], slashCommands: ['/help'] } : {});
    deniedSignal.mockRestore();
    deniedChildKill.mockRestore();
    if (emitInit) {
      await killProcessTree({ pid: ownedPid() });
      expect(await extractSDKMetadata()).toEqual(metadata);
    }
  } finally {
    deniedSignal.mockRestore();
    deniedChildKill.mockRestore();
    await killProcessTree({ pid: ownedPid() });
    process.chdir(originalCwd);
  }
});
