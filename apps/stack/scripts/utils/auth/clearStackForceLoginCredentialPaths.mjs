import { resolveStackCredentialPaths } from './credentials_paths.mjs';
import { removeFileOrSymlinkIfExists } from './files.mjs';

export async function clearStackForceLoginCredentialPaths({
  cliHomeDir,
  serverUrl,
  env = process.env,
}) {
  const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
  const attemptedPaths = [...new Set(resolved.paths.map((path) => String(path ?? '').trim()).filter(Boolean))];
  const removedPaths = [];

  for (const path of attemptedPaths) {
    // eslint-disable-next-line no-await-in-loop
    const removed = await removeFileOrSymlinkIfExists(path);
    if (removed) removedPaths.push(path);
  }

  return { attemptedPaths, removedPaths };
}
