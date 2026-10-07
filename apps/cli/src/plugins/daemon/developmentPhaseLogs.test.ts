import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { bindProcessLogger, Logger } from '@/ui/logger';

import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

it('logs real candidate evaluation and adoption, then logs a failed edit while retaining the serving occurrence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-phase-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.phase-log';
  const logPath = join(root, 'development.log');
  const localLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
  const restoreLogger = bindProcessLogger(localLogger);
  const reloadController = createPluginReloadController({
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
      contributes: createResolvedContributionRegistry({}),
    }),
  });
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir: root,
    staleCandidateCleanup: 'disabled',
    reloadController,
    connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir: root, pluginId }).owner,
  });
  try {
    const initialRegistry = await reloadController.acquireRuntimeRegistry();
    await initialRegistry.release();
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined }))};`,
      'export function activate() {}',
    ].join('\n'));
    const control = owner.changeService.controlPluginDevelopment!;
    await control({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await owner.changeService.listPendingPluginChanges()).changes[0];
    expect(pending).toBeDefined();
    await expect(owner.changeService.decidePluginChange({ pendingChangeId: pending!.pendingChangeId, decision: 'installAndTrust' }))
      .resolves.toMatchObject({ kind: 'committed', pluginId });
    const occurrenceId = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    expect(occurrenceId).toBeTruthy();
    await writeFile(entryPath, "throw new Error('phase candidate evaluation failed');\n");
    await control({ kind: 'reload', rootPath: entryPath });
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBe(occurrenceId);
    localLogger.flushSync();
    const log = await readFile(logPath, 'utf8');
    expect(log).toMatch(/evaluate completed in \d+\.\d s/u);
    expect(log).toMatch(/adopt completed in \d+\.\d s/u);
    expect(log).toMatch(/evaluate failed in \d+\.\d s/u);
    expect(log).toContain('"elapsedMs":');
    expect(log).not.toContain('dependency prep completed');
    expect(log).not.toContain('build completed');
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    restoreLogger();
    await rm(root, { recursive: true, force: true });
  }
});
