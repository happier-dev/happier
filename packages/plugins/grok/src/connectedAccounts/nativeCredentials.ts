import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import type { XaiCredential } from './credential.js';

import { parseGrokAuthStore } from './nativeAuth.js';
export { parseGrokAuthStore, serializeGrokSelectedAuth } from './nativeAuth.js';
export { GROK_XAI_ISSUER, GROK_XAI_CLIENT_ID } from './service.js';

/** Explicit native import reads one configured file and never executes a credential command. */
export async function readGrokNativeCredential(options: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>; scope?: string; signal?: AbortSignal;
}> = {}): Promise<XaiCredential> {
  const environment = options.environment ?? process.env;
  const homeDir = resolveHomeDirFromEnvironment(environment);
  const home = environment.GROK_HOME?.trim()
    ? resolveConfiguredPath(environment.GROK_HOME, { homeDir }) : join(homeDir, '.grok');
  const path = environment.GROK_AUTH_PATH?.trim()
    ? resolveConfiguredPath(environment.GROK_AUTH_PATH, { homeDir }) : join(home, 'auth.json');
  const contents = await readFile(path, { encoding: 'utf8', signal: options.signal });
  return parseGrokAuthStore(contents, options);
}
