#!/usr/bin/env node

/**
 * CLI entry point for happier command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import { dispatchCli } from '@/cli/dispatch';
import { normalizeCliArgv, parseCliArgs } from '@/cli/parseArgs';
import { initToolTraceIfEnabled } from '@/agent/tools/trace/toolTrace';
import axios from 'axios';
import { configuration } from '@/configuration';
import { maybeAutoUpdateNotice } from '@/cli/runtime/update/autoUpdateNotice';
import { maybeReexecToRuntime } from '@/cli/runtime/update/runtimeReexec';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json';
import { resolveNpmPackageNameOverride } from '@happier-dev/cli-common/update';
import { installAxiosProxySupport } from '@/utils/proxy/axiosProxy';
import { ensureWindowsUtf8CodePage } from '@/utils/platform/windows/ensureWindowsUtf8CodePage';
import { installConsoleWriteErrorGuards, shouldInstallConsoleWriteErrorGuards } from '@/utils/writeConsoleBestEffort';

void (async () => {
  // Best-effort Windows console hardening for Unicode output (workaround for upstream reports of mojibake when
  // launching via npm-generated wrappers). Opt-out via HAPPIER_WINDOWS_UTF8_CODEPAGE=0.
  ensureWindowsUtf8CodePage();
  if (shouldInstallConsoleWriteErrorGuards({ processVersions: process.versions })) {
    installConsoleWriteErrorGuards();
  }
  initToolTraceIfEnabled();
  installAxiosProxySupport({ axios, env: process.env });
  const cliRootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const normalizedArgv = normalizeCliArgv(process.argv.slice(2));
  const updatePackageName = resolveNpmPackageNameOverride({
    envValue: process.env.HAPPIER_CLI_UPDATE_PACKAGE_NAME,
    fallback: packageJson.name,
  });
  await maybeReexecToRuntime({
    argv: normalizedArgv,
    cliRootDir,
    homeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing,
    packageName: updatePackageName,
    env: process.env,
  });
  maybeAutoUpdateNotice({
    argv: normalizedArgv,
    isTTY: Boolean(process.stderr.isTTY),
    homeDir: configuration.happyHomeDir,
    cliRootDir,
    env: process.env,
    publicReleaseRing: configuration.publicReleaseRing,
  });
  const { args, terminalRuntime } = parseCliArgs(normalizedArgv);
  await dispatchCli({ args, terminalRuntime, rawArgv: process.argv });
})().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
  if (process.env.DEBUG) {
    console.error(error);
  }
  process.exitCode = 1;
});
