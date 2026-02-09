import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { resolveServerPortFromEnv } from '../utils/server/urls.mjs';
import { getCliHomeDirFromEnvOrDefault } from '../utils/stack/dirs.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveHandyMasterSecretFromStack } from '../utils/auth/handy_master_secret.mjs';
import { copyFileIfMissing, linkFileIfMissing, writeSecretFileIfMissing } from '../utils/auth/files.mjs';
import { findAnyCredentialPathInCliHome, findExistingStackCredentialPath, resolveStackCredentialPaths } from '../utils/auth/credentials_paths.mjs';

const readExistingEnv = readTextOrEmpty;

export async function copyAuthFromStackIntoNewStack({
  fromStackName,
  stackName,
  stackEnv,
  serverComponent,
  json,
  requireSourceStackExists,
  linkMode = false,
}) {
  const { secret, source } = await resolveHandyMasterSecretFromStack({
    stackName: fromStackName,
    requireStackExists: requireSourceStackExists,
  });

  const copied = { secret: false, accessKey: false, settings: false, sourceStack: fromStackName };

  if (secret) {
    if (serverComponent === 'happier-server-light') {
      const dataDir = stackEnv.HAPPIER_SERVER_LIGHT_DATA_DIR;
      const target = join(dataDir, 'handy-master-secret.txt');
      const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
      copied.secret =
        linkMode && sourcePath && existsSync(sourcePath)
          ? await linkFileIfMissing({ from: sourcePath, to: target })
          : await writeSecretFileIfMissing({ path: target, secret });
    } else if (serverComponent === 'happier-server') {
      const target = stackEnv.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE;
      if (target) {
        const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
        copied.secret =
          linkMode && sourcePath && existsSync(sourcePath)
            ? await linkFileIfMissing({ from: sourcePath, to: target })
            : await writeSecretFileIfMissing({ path: target, secret });
      }
    }
  }

  const { baseDir: sourceBaseDir, envPath: sourceEnvPath } = resolveStackEnvPath(fromStackName);
  const sourceEnvRaw = await readExistingEnv(sourceEnvPath);
  const sourceEnv = parseEnvToObject(sourceEnvRaw);
  const sourceCli = getCliHomeDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env: sourceEnv });
  const targetCli = stackEnv.HAPPIER_STACK_CLI_HOME_DIR;
  const sourceInternalServerUrl = `http://127.0.0.1:${resolveServerPortFromEnv({ env: sourceEnv, defaultPort: 3005 })}`;
  const targetInternalServerUrl = `http://127.0.0.1:${resolveServerPortFromEnv({ env: stackEnv, defaultPort: 3005 })}`;
  const sourceEnvScoped = applyStackActiveServerScopeEnv({ env: sourceEnv, stackName: fromStackName, cliIdentity: 'default' });
  const targetEnvScoped = applyStackActiveServerScopeEnv({ env: stackEnv, stackName, cliIdentity: 'default' });
  const sourceCredentialPaths = resolveStackCredentialPaths({
    cliHomeDir: sourceCli,
    serverUrl: sourceInternalServerUrl,
    env: sourceEnvScoped,
  });
  const targetCredentialPaths = resolveStackCredentialPaths({
    cliHomeDir: targetCli,
    serverUrl: targetInternalServerUrl,
    env: targetEnvScoped,
  });
  const sourceAccessKeyPath =
    findExistingStackCredentialPath({ cliHomeDir: sourceCli, serverUrl: sourceInternalServerUrl, env: sourceEnvScoped }) ||
    [sourceCredentialPaths.serverScopedPath, sourceCredentialPaths.urlHashServerScopedPath, sourceCredentialPaths.legacyPath]
      .filter(Boolean)
      .find((candidate) => existsSync(candidate)) ||
    findAnyCredentialPathInCliHome({ cliHomeDir: sourceCli });

  if (linkMode) {
    copied.accessKey =
      sourceAccessKeyPath
        ? await linkFileIfMissing({ from: sourceAccessKeyPath, to: targetCredentialPaths.serverScopedPath })
        : false;
    copied.settings = await linkFileIfMissing({ from: join(sourceCli, 'settings.json'), to: join(targetCli, 'settings.json') });
  } else {
    copied.accessKey =
      sourceAccessKeyPath
        ? await copyFileIfMissing({
            from: sourceAccessKeyPath,
            to: targetCredentialPaths.serverScopedPath,
            mode: 0o600,
          })
        : false;
    copied.settings = await copyFileIfMissing({
      from: join(sourceCli, 'settings.json'),
      to: join(targetCli, 'settings.json'),
      mode: 0o600,
    });
  }

  if (!json) {
    const any = copied.secret || copied.accessKey || copied.settings;
    if (any) {
      console.log(`[stack] copied auth from "${fromStackName}" into "${stackName}" (no re-login needed)`);
      if (copied.secret) console.log(`  - master secret: copied (${source || 'unknown source'})`);
      if (copied.accessKey) console.log(`  - cli: copied access.key`);
      if (copied.settings) console.log(`  - cli: copied settings.json`);
    }
  }

  return copied;
}
