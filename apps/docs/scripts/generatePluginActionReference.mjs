/**
 * Adapts Protocol's canonical Plugin Action reference renderer to the Docs
 * generator registry. Protocol owns the Action semantics and Markdown bytes;
 * Docs owns whether every published generated page is current.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const RENDERER = join(REPO, 'packages', 'protocol', 'src', 'actions', 'pluginActionReference.ts');

const SOURCE_RUNTIME = join(REPO, 'packages', 'cli-common', 'registerSourceRuntime.mjs');
const FEATURE_POLICY_GENERATOR = join(REPO, 'packages', 'protocol', 'scripts', 'generate-embedded-feature-policies.mjs');

export const OUTPUT_PATH = join(
  HERE,
  '..',
  'content',
  'docs',
  'plugins',
  'api',
  'host-actions.mdx',
);

export async function renderPluginActionReferenceMarkdown({ rendererPath = RENDERER } = {}) {
  await access(rendererPath);
  if (rendererPath === RENDERER) {
    const { EMBEDDED_FEATURE_POLICIES_OUTPUT, writeEmbeddedFeaturePolicies } = await import(
      pathToFileURL(FEATURE_POLICY_GENERATOR).href
    );
    try {
      await access(join(REPO, EMBEDDED_FEATURE_POLICIES_OUTPUT));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeEmbeddedFeaturePolicies({ repoRoot: REPO });
    }
  }
  // Use the authored workspace graph in a fresh process so earlier generators
  // cannot supply stale Action specs from their module cache.
  return execFileSync(process.execPath, [
    '--conditions=happier-source',
    '--import', pathToFileURL(SOURCE_RUNTIME).href,
    '--input-type=module',
    '-e',
    'const renderer = await import(process.argv[1]); process.stdout.write(renderer.renderPluginActionReferenceMarkdown());',
    pathToFileURL(rendererPath).href,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    // The reference grows with the canonical catalog, not a subprocess buffer cap.
    maxBuffer: Infinity,
  });
}
