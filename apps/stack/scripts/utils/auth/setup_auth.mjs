import { findAnyCredentialPathInCliHome } from './credentials_paths.mjs';
import { resolveCliHomeDir } from '../stack/dirs.mjs';

export function findSetupAuthCredentialPath(env = process.env) {
  const cliHomeDir = resolveCliHomeDir(env);
  return findAnyCredentialPathInCliHome({ cliHomeDir });
}
