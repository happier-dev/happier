import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH,
  parseBundledPluginPublicationFailures } from '../../../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';

function notReady(reason, cause, failures = []) {
  const pluginFailures = failures.map(({ pluginId, diagnostic }) => ({ pluginId, diagnostic: { code: diagnostic.code } }));
  const detail = pluginFailures.map(({ pluginId, diagnostic }) => `${pluginId} ${diagnostic.code}`).join(', ');
  return Object.assign(new Error(`[reload] replacement bundled plugin publication is not ready${detail ? `: ${detail}` : ''}; incumbent retained`,
    cause ? { cause } : undefined), {
    code: 'ESOURCERELOADNOTREADY', component: 'daemon', entryGraph: 'daemon',
    phase: 'bundled-plugin-publication', reason, ...(pluginFailures.length ? { pluginFailures } : {}),
  });
}

async function readFailures(cliDir) {
  return parseBundledPluginPublicationFailures(await readFile(
    join(cliDir, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH), 'utf8'));
}

/** Admission compares the canonical publisher's result before any retirement.
 * Empty is healthy; a retained failure may continue only when unchanged. */
export async function assertSourceReloadBundledPluginFailures({ replacementCliDir, incumbentCliDir }) {
  let replacement;
  try { replacement = await readFailures(replacementCliDir); }
  catch (cause) { throw notReady('bundled_plugin_failures_unavailable', cause); }
  if (replacement.length === 0) return;
  let incumbent;
  try { incumbent = incumbentCliDir ? await readFailures(incumbentCliDir) : null; }
  catch (cause) { throw notReady('bundled_plugin_baseline_unavailable', cause, replacement); }
  if (!isDeepStrictEqual(replacement, incumbent)) throw notReady('bundled_plugin_failures_changed', undefined, replacement);
}
