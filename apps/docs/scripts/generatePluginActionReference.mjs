/**
 * Adapts Protocol's canonical Plugin Action reference renderer to the Docs
 * generator registry. Protocol owns the Action semantics and Markdown bytes;
 * Docs owns whether every published generated page is current.
 */
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const RENDERER = join(REPO, 'packages', 'protocol', 'dist', 'actions', 'pluginActionReference.js');

export const OUTPUT_PATH = join(
  HERE,
  '..',
  'content',
  'docs',
  'plugins',
  'api',
  'host-actions.mdx',
);

export async function renderPluginActionReferenceMarkdown({
  rendererPath = RENDERER,
  ensureWorkspacePackagesBuiltByName = ensureWorkspacePackagesBuiltByNameDefault,
  loadRenderer = async (path) => await import(pathToFileURL(path).href),
} = {}) {
  await ensureWorkspacePackagesBuiltByName(REPO, ['@happier-dev/protocol'], {
    force: true,
    includeDevDependencies: false,
    publicationMode: 'live',
    quiet: true,
  });
  const protocol = await loadRenderer(rendererPath);
  return protocol.renderPluginActionReferenceMarkdown();
}
