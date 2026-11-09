import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createPluginCliActionHost } from '@/plugins/testkit/pluginCliActionHost';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

describe('publication Action Machine transport', () => {
  const directories: string[] = [];
  afterEach(async () => {
    resetActiveAccountSettingsSnapshotForTests();
    await Promise.all(directories.splice(0).map(removeTempDir));
  });

  it('prepares the selected Machine archive through the real CLI requester and receiver', async () => {
    const root = await createTempDir('happier-publication-action-');
    directories.push(root);
    const projectRoot = join(root, 'plugin');
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture()));
    await writeFile(join(projectRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: '@fixture/publication-action', version: '1.0.0', keywords: ['happier-plugin'],
      happier: { manifest: '.happier-plugin/plugin.json' }, files: ['.happier-plugin', 'daemon.mjs'] }));
    const host = await createPluginCliActionHost({ happyHomeDir: join(root, 'home') });
    try {
      const result = await host.executePluginAction('plugins.dev.publication.prepare', { machineId: 'machine-2', projectRoot,
        publication: { packageName: '@fixture/reviewed-publication', title: 'Reviewed listing' } });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, kind: 'plugins_dev_publication_prepare',
        result: { status: 'prepared', packageName: '@fixture/reviewed-publication', publication: { title: 'Reviewed listing' } } } });
      expect(host.delivered).toHaveLength(1);
      expect(host.delivered[0]).toMatchObject({ target: { kind: 'machine', machineId: 'machine-2' } });
      expect(getActionSpec('plugins.dev.publication.prepare').outputSchema.safeParse(result.ok ? result.result : null).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain('authorizationHeader');
    } finally { await host.dispose(); }
  });
});
