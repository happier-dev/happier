/**
 * Adapts Protocol's canonical Plugin Action reference renderer to the Docs
 * generator registry. Protocol owns the Action semantics and Markdown bytes;
 * Docs owns whether every published generated page is current.
 */
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const RENDERER = join(REPO, 'packages', 'protocol', 'dist', 'actions', 'pluginActionReference.js');

function loadRendererFromCurrentBuild(rendererPath) {
  return {
    renderPluginActionReferenceMarkdown: () => execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      'const renderer = await import(process.argv[1]); process.stdout.write(renderer.renderPluginActionReferenceMarkdown());',
      pathToFileURL(rendererPath).href,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      // The reference grows with the canonical catalog, not a subprocess buffer cap.
      maxBuffer: Infinity,
    }),
  };
}

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
  // Earlier reference generators may have loaded the previous built Protocol
  // graph. Read the refreshed build in its own module cache after preparation.
  loadRenderer = loadRendererFromCurrentBuild,
} = {}) {
  await ensureWorkspacePackagesBuiltByName(REPO, ['@happier-dev/protocol'], {
    includeDevDependencies: false,
    publicationMode: 'live',
    quiet: true,
  });
  const protocol = await loadRenderer(rendererPath);
  return protocol.renderPluginActionReferenceMarkdown();
}
