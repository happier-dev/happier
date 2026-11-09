import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import type { PluginPublicationBotTemplate, PluginPublicationMetadata } from '@happier-dev/protocol/actions/actionSpecs';

/** A generated template is an ordinary descriptor package consumed by the same pack owner. */
export async function withPublicationProject<T>(input: Readonly<{ projectRoot?: string; botTemplate?: PluginPublicationBotTemplate;
  publication?: PluginPublicationMetadata }>, use: (projectRoot: string) => Promise<T>): Promise<T> {
  if (!input.botTemplate) {
    if (!input.projectRoot) throw new Error('publication_source_required');
    return use(input.projectRoot);
  }
  const root = await createHappierTempDir({ purpose: 'bot-template-publication' });
  try {
    const { release } = input.botTemplate;
    const packageName = input.publication?.packageName ?? 'happier-plugin-bot-template';
    const version = input.publication?.version ?? release.version;
    const changelog = input.publication?.changelog ?? release.changelog;
    const descriptor = join(root, '.happier-plugin');
    await mkdir(descriptor, { recursive: true });
    // npm package identity is the only input; no private Artifact address is portable.
    const id = `bot.template.${createHash('sha256').update(packageName).digest('hex')}`;
    await Promise.all([
      writeFile(join(root, 'package.json'), JSON.stringify({ name: packageName, version,
        keywords: ['happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' }, files: ['.happier-plugin'] })),
      writeFile(join(descriptor, 'plugin.json'), JSON.stringify({ schemaVersion: 2, id, version,
        displayName: release.content.identity.name, description: release.content.identity.description,
        runtime: { apiVersion: 1 }, entrypoints: {}, hostAccess: { required: [], optional: [] },
        contributes: { botTemplates: [{ id: 'template', path: '.happier-plugin/bot-template.json' }] } })),
      writeFile(join(descriptor, 'bot-template.json'), JSON.stringify({ ...release, version, changelog })),
    ]);
    return await use(root);
  } finally {
    await removeHappierTempDirAsync(root);
  }
}
