#!/usr/bin/env node

/**
 * CLI entry point for happier command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import { dispatchCli } from '@/cli/dispatch';
import { parseCliArgs } from '@/cli/parseArgs';
import { initToolTraceIfEnabled } from '@/agent/tools/trace/toolTrace';
import { configuration } from '@/configuration';
import { maybeAutoUpdateNotice } from '@/update/autoUpdateNotice';
import { maybeReexecToRuntime } from '@/update/runtimeReexec';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json';
import { resolveNpmPackageNameOverride } from '@happier-dev/cli-common/update';

void (async () => {
  initToolTraceIfEnabled();
  const cliRootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const updatePackageName = resolveNpmPackageNameOverride({
    envValue: process.env.HAPPIER_CLI_UPDATE_PACKAGE_NAME,
    fallback: packageJson.name,
  });
  maybeReexecToRuntime({
    argv: process.argv.slice(2),
    cliRootDir,
    homeDir: configuration.happyHomeDir,
    packageName: updatePackageName,
    env: process.env,
  });
  maybeAutoUpdateNotice({
    argv: process.argv.slice(2),
    isTTY: Boolean(process.stderr.isTTY),
    homeDir: configuration.happyHomeDir,
    cliRootDir,
    env: process.env,
  });
  const { args, terminalRuntime } = parseCliArgs(process.argv.slice(2));
  await dispatchCli({ args, terminalRuntime, rawArgv: process.argv });
})();
