import '../configureZodLocale';
import { dispatchCli } from '@/cli/dispatch';
import { readCliProcessArgs, parseCliArgs } from '@/cli/parseArgs';
import { initToolTraceIfEnabled } from '@/agent/tools/trace/toolTrace';
import axios from '@/api/client/credentialAxios';
import { configuration } from '@/configuration';
import { maybeAutoUpdateNotice } from '@/cli/runtime/update/autoUpdateNotice';
import { maybeReexecToRuntime } from '@/cli/runtime/update/runtimeReexec';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json';
import { resolveNpmPackageNameOverride } from '@happier-dev/cli-common/update';
import { installAxiosProxySupport } from '@/utils/proxy/axiosProxy';
import { ensureWindowsUtf8CodePage } from '@/utils/platform/windows/ensureWindowsUtf8CodePage';
import { installConsoleWriteErrorGuards, shouldInstallConsoleWriteErrorGuards } from '@/utils/writeConsoleBestEffort';
import { logger } from '@/ui/logger';
import { applyStackSessionPriority } from '@/utils/process/applyStackSessionPriority';
import { installTerminalAuthorityCeiling } from '@/api/client/terminalAuthorityCeiling';
import { fail } from '@happier-dev/cli-common/output';
import { joinCurrentWindowsSessionProcessCustody } from '@/subprocess/supervision/processCustody';

export async function runCliBootstrap(entrypointUrl: string): Promise<void> {
  try {
    const custody = await joinCurrentWindowsSessionProcessCustody();
    if (custody?.state === 'unavailable') logger.debug('[process-custody] session Job join unavailable');
    applyStackSessionPriority();
    // Best-effort Windows console hardening for Unicode output (workaround for upstream reports of mojibake when
    // launching via npm-generated wrappers). Opt-out via HAPPIER_WINDOWS_UTF8_CODEPAGE=0.
    ensureWindowsUtf8CodePage();
    if (shouldInstallConsoleWriteErrorGuards({ processVersions: process.versions })) {
      installConsoleWriteErrorGuards();
    }
    initToolTraceIfEnabled();
    installAxiosProxySupport({ axios, env: process.env });
    installTerminalAuthorityCeiling(axios);
    const cliRootDir = dirname(dirname(fileURLToPath(entrypointUrl)));
    const normalizedArgv = readCliProcessArgs();
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
  } catch (error) {
    logger.fatal(error);
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
