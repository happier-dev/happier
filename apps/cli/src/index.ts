#!/usr/bin/env node

/**
 * CLI entry point for happier command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import { isFamilyHelpRequest, isTopLevelHelpRequest, readCliProcessArgs } from './cli/processArgs';
import { isTopLevelVersionRequest, printCliVersion } from './cli/version';

const isCliDistIntegrityProbe = process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE === '1';

if (!isCliDistIntegrityProbe && isTopLevelVersionRequest(readCliProcessArgs())) {
  printCliVersion();
} else if (!isCliDistIntegrityProbe && readCliProcessArgs()[0] === 'filesystem-effect') {
  // Host-private native IO: never bootstrap an Account or daemon in this child.
  void import('./rpc/handlers/fileSystem/filesystemEffectInternal').then(async ({ runFilesystemEffectInternal }) => {
    if (readCliProcessArgs().length !== 1) throw new Error('filesystem_effect_operation_invalid');
    const controller = new AbortController();
    const stop = () => { controller.abort(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try { await runFilesystemEffectInternal(process.stdin, process.stdout, controller.signal); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  }).catch(() => { process.stderr.write('filesystem_effect_operation_failed\n'); process.exitCode = 1; });
} else if (!isCliDistIntegrityProbe && readCliProcessArgs()[0] === 'agent-launch') {
  // The RunAs shim cannot enter Account/bootstrap initialization under the
  // Agent identity. Its static descriptor also reserves this internal command.
  void import('./cli/commands/agentLaunch').then(({ handleAgentLaunchCliCommand }) =>
    handleAgentLaunchCliCommand({ args: readCliProcessArgs(), rawArgv: process.argv, terminalRuntime: null }))
    .catch(() => { process.stderr.write('agent_launch_unavailable\n'); process.exitCode = 1; });
} else {
  // A pending Promise alone does not keep Node alive. Keep the CLI process
  // referenced until async command dispatch (including install cleanup) settles.
  const cliLifetimeKeepAlive = isCliDistIntegrityProbe ? null : setInterval(() => undefined, 60_000);
  const runBootstrap = () => import('./cli/bootstrap').then(async ({ runCliBootstrap }) => {
    if (!isCliDistIntegrityProbe) await runCliBootstrap(import.meta.url);
  });
  const dispatch = !isCliDistIntegrityProbe && isTopLevelHelpRequest(readCliProcessArgs())
    ? import('./cli/rootHelp').then(({ printRootHelp }) => printRootHelp())
    : !isCliDistIntegrityProbe && isFamilyHelpRequest(readCliProcessArgs())
      ? import('./cli/familyHelp').then(async ({ tryPrintFamilyHelp }) => {
        if (!await tryPrintFamilyHelp(readCliProcessArgs())) await runBootstrap();
      })
      : runBootstrap();
  void dispatch.catch((error) => {
      // Bootstrap's own failures retain its logger/formatting; a failed module
      // import must be reported without importing the same graph again.
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      if (process.env.DEBUG) console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      if (cliLifetimeKeepAlive !== null) clearInterval(cliLifetimeKeepAlive);
    });
}
