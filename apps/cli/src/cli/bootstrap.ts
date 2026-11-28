import '../configureZodLocale';
import { readCliProcessArgs } from '@/cli/processArgs';
import { CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV } from '@/auth/cliApiTokenEnvironment';
import { applyDaemonAutostartEnvForInvocation } from '@/daemon/daemonAutostartPolicy';
import { initToolTraceIfEnabled } from '@/agent/tools/trace/toolTrace';
import axios from '@/api/client/credentialAxios';
import { configuration } from '@/configuration';
import { maybeReexecToRuntime } from '@/cli/runtime/update/runtimeReexec';
import { dirname } from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json' with { type: 'json' };
import { resolveNpmPackageNameOverride } from '@happier-dev/cli-common/update';
import { installAxiosProxySupport } from '@/utils/proxy/axiosProxy';
import { ensureWindowsUtf8CodePage } from '@/utils/platform/windows/ensureWindowsUtf8CodePage';
import { installConsoleWriteErrorGuards, shouldInstallConsoleWriteErrorGuards } from '@/utils/writeConsoleBestEffort';
import { logger } from '@/ui/logger';
import { applyStackSessionPriority } from '@/utils/process/applyStackSessionPriority';
import { fail } from '@happier-dev/cli-common/output';
import { joinCurrentWindowsSessionProcessCustody } from '@/subprocess/supervision/processCustody';

export async function runCliBootstrap(entrypointUrl: string): Promise<void> {
  try {
    // Extend process defaults before dispatch opens HTTPS or WebSocket connections.
    // The bundled Node supports this API. Older system Node runtimes retain their defaults.
    if (typeof tls.setDefaultCACertificates === 'function') {
      tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
    }
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
    if (normalizedArgv.length === 1 && normalizedArgv[0] === 'session-host'
      && !process.stderr.isTTY && configuration.organizationPolicy.status !== 'invalid'
      && !Object.keys(process.env).some(key => {
        const name = key.toUpperCase();
        return name === CLI_API_TOKEN_ENV || name === CLI_API_TOKEN_HANDOFF_ENV;
      })) {
      // The daemon supplies the Home and the host endpoint checks its process birth.
      // Runner CLI dispatch belongs to the first authorized add, or intent preload.
      const { handleSessionHostCliCommand } = await import('@/cli/commands/sessionHost');
      applyDaemonAutostartEnvForInvocation({ args: normalizedArgv, env: process.env });
      if (process.env.DEBUG) logger.debug('Starting happy CLI with args: ', process.argv);
      await handleSessionHostCliCommand({ args: normalizedArgv, rawArgv: process.argv, terminalRuntime: null });
      return;
    }
    const [{ maybeAutoUpdateNotice }, { parseCliArgs }, { dispatchCli }] = await Promise.all([
      import('@/cli/runtime/update/autoUpdateNotice'),
      import('@/cli/parseArgs'),
      import('@/cli/dispatch'),
    ]);
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
