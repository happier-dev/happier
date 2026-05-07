import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMacOsDesktopApp, resolveMacOsDesktopInstallPlan } from './desktop_install.mjs';

test('installMacOsDesktopApp replaces an existing stack-scoped macOS app bundle', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-desktop-install-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const sourceApp = join(tmp, 'build', 'Happier (local-prod).app');
  const installDir = join(tmp, 'Applications');
  const targetApp = join(installDir, 'Happier (local-prod).app');
  await mkdir(join(sourceApp, 'Contents'), { recursive: true });
  await mkdir(join(targetApp, 'Contents'), { recursive: true });
  await writeFile(join(sourceApp, 'Contents', 'marker.txt'), 'new-build', 'utf-8');
  await writeFile(join(targetApp, 'Contents', 'marker.txt'), 'old-build', 'utf-8');

  const result = await installMacOsDesktopApp({
    productName: 'Happier (local-prod)',
    sourceAppPath: sourceApp,
    installDir,
  });

  assert.equal(result.targetAppPath, targetApp);
  assert.equal(await readFile(join(targetApp, 'Contents', 'marker.txt'), 'utf-8'), 'new-build');
});

test('resolveMacOsDesktopInstallPlan sanitizes app bundle path separators', () => {
  const plan = resolveMacOsDesktopInstallPlan({
    productName: 'Happier: local/prod',
    sourceAppPath: '/tmp/source.app',
    homeDir: '/Users/alice',
    env: {},
  });

  assert.equal(plan.productName, 'Happier- local-prod');
  assert.equal(plan.targetAppPath, '/Users/alice/Applications/Happier- local-prod.app');
});
