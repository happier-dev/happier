import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  OPEN_CODE_BROKER_PROVIDERS,
  type OpenCodeBrokerProvider,
} from './env.js';
import {
  buildOpenCodeBrokerPluginSource,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
} from './source.js';

/**
 * Deterministic, version-keyed on-disk paths for the broker assets. They are derived purely from a
 * caller-provided, Happier-owned isolated config-home directory + the plugin version, so:
 *  - the materializer can REFERENCE the paths (and the `XDG_CONFIG_HOME` it emits) without any
 *    filesystem I/O (keeping it pure + overlay-safe for fingerprint computation), and
 *  - the live server-launch path can WRITE the assets idempotently.
 *
 * Unlike a global singleton, the config home is per-selection (the connected-service home dir), so
 * each connected selection gets a fully isolated OpenCode config home with NO user 3rd-party plugins.
 */

/**
 * OpenCode's plugin auto-discovery dir, RELATIVE TO the (redirected) `XDG_CONFIG_HOME`. Live-verified
 * against opencode v1.14.41: it scans `<XDG_CONFIG_HOME>/opencode/plugin/` and loads each plugin file
 * from there. The broker plugin lives here so that pointing `XDG_CONFIG_HOME` at the connected config
 * home (config isolation) is sufficient to load it — no `OPENCODE_CONFIG_CONTENT` registration is
 * needed (and an absolute path in `config.plugin` does NOT load).
 */
export function resolveOpenCodeBrokerPluginDir(connectedConfigHomeDir: string): string {
  return join(connectedConfigHomeDir, 'opencode', 'plugin');
}

export function resolveOpenCodeBrokerPluginPath(
  provider: OpenCodeBrokerProvider,
  connectedConfigHomeDir: string,
): string {
  // MUST be `.js`: opencode v1.14.41's plugin auto-discovery globs `*.js` ONLY and ignores `*.mjs`
  // (live-verified head-to-head in the same dir). A `.mjs` broker file is silently never loaded.
  return join(
    resolveOpenCodeBrokerPluginDir(connectedConfigHomeDir),
    `happier-broker-${provider}-${OPEN_CODE_BROKER_PLUGIN_VERSION}.js`,
  );
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === content) return;
  await writeFile(path, content, { mode: 0o600 });
}

/**
 * Idempotently materialize the broker assets for the given providers into a Happier-owned isolated
 * config home:
 *  - ensure the config home exists (isolated ⇒ no user 3rd-party plugins), and
 *  - write each provider's self-contained broker plugin `.js` file into the config home's
 *    `opencode/plugin/` auto-load dir so OpenCode discovers + loads it from the redirected
 *    `XDG_CONFIG_HOME` (live-verified mechanism; `.mjs` + `OPENCODE_CONFIG_CONTENT.plugin` do not load).
 *
 * Safe to call repeatedly (write-if-changed). Called from the live server-launch path only.
 */
export async function ensureOpenCodeBrokerPluginAssets(params: Readonly<{
  providers: readonly OpenCodeBrokerProvider[];
  connectedConfigHomeDir: string;
}>): Promise<void> {
  await mkdir(params.connectedConfigHomeDir, { recursive: true });
  const providers = params.providers.filter((provider) => OPEN_CODE_BROKER_PROVIDERS.includes(provider));
  if (providers.length === 0) return;
  await mkdir(resolveOpenCodeBrokerPluginDir(params.connectedConfigHomeDir), { recursive: true });
  await Promise.all(providers.map(async (provider) => {
    await writeFileIfChanged(
      resolveOpenCodeBrokerPluginPath(provider, params.connectedConfigHomeDir),
      buildOpenCodeBrokerPluginSource(provider),
    );
  }));
}
