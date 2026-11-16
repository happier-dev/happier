#!/usr/bin/env node

/**
 * CLI entry point for happier command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import { isFamilyHelpRequest, isTopLevelHelpRequest, readCliProcessArgs } from './cli/processArgs';
import { isTopLevelVersionRequest, printCliVersion } from './cli/version';
import type { MachineEffectInternalRecord } from './machines/setup/effectInternalProtocol';

const isCliDistIntegrityProbe = process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE === '1';

if (!isCliDistIntegrityProbe && isTopLevelVersionRequest(readCliProcessArgs())) {
  printCliVersion();
} else if (!isCliDistIntegrityProbe && readCliProcessArgs()[0] === 'machine' && readCliProcessArgs()[1] === 'effect-internal') {
  // The already admitted root process consumes only its closed stdin plan. It
  // must not initialize Account state, update itself or start another daemon.
  void import('./machines/setup/effectInternal').then(async ({ runMachineSetupEffectInternal }) => {
    process.exitCode = await runMachineSetupEffectInternal(readCliProcessArgs().slice(2));
  }).catch(() => {
    // Even an unavailable module graph settles the private protocol without
    // exposing loader errors or announcing readiness to receive the plan.
    const record: MachineEffectInternalRecord = { type: 'result', result: {
      status: 'unavailable', reason: 'entry_unavailable', completedStepIds: [], daemonRestartRequired: false,
    } };
    process.stdout.write(JSON.stringify(record) + '\n');
    process.exitCode = 1;
  });
} else if (!isCliDistIntegrityProbe && readCliProcessArgs()[0] === 'workspace-effect') {
  // Native private pipe only; never enter Account/daemon/bootstrap under member UID.
  void import('./cli/commands/workspaceEffect').then(({ runWorkspaceEffectCommand }) =>
    runWorkspaceEffectCommand(readCliProcessArgs().slice(1)))
    .catch(() => { process.stderr.write('workspace_effect_unavailable\n'); process.exitCode = 1; });
} else if (!isCliDistIntegrityProbe && readCliProcessArgs()[0] === 'computer-effect') {
  // Private native desktop child: no Account or daemon bootstrap under its selected uid.
  void import('./daemon/computer/memberRuntimeInternal').then(async ({ runMemberComputerRuntimeInternal }) => {
    if (readCliProcessArgs().length !== 1) throw new Error('computer_effect_operation_invalid');
    const controller = new AbortController();
    const stop = () => { controller.abort(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { await runMemberComputerRuntimeInternal(process.stdin, process.stdout, controller.signal); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  }).catch(() => { process.stderr.write('computer_effect_operation_failed\n'); process.exitCode = 1; });
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
} else if (!isCliDistIntegrityProbe && readCliProcessArgs()[0] === 'agent-install-effect') {
  // Private native installer/resolver: never bootstrap Account or daemon state.
  void import('./capabilities/installJobs/memberInstallEffect').then(async ({ runMemberAgentInstallEffect }) => {
    if (readCliProcessArgs().length !== 1) throw new Error('agent_install_effect_invalid');
    const controller = new AbortController();
    const stop = () => { controller.abort(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { await runMemberAgentInstallEffect(process.stdin, process.stdout, controller.signal); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  }).catch(() => { process.stderr.write('agent_install_effect_failed\n'); process.exitCode = 1; });
} else if (!isCliDistIntegrityProbe && readCliProcessArgs()[0] === 'agent-launch') {
  // The RunAs shim cannot enter Account/bootstrap initialization under the
  // Agent identity. Its static descriptor also reserves this internal command.
  void import('./cli/commands/agentLaunch').then(({ handleAgentLaunchCliCommand }) =>
    handleAgentLaunchCliCommand({ args: readCliProcessArgs(), rawArgv: process.argv, terminalRuntime: null }))
    .catch(() => { process.stderr.write('agent_launch_unavailable\n'); process.exitCode = 1; });
} else {
  // A pending Promise alone does not keep Node alive. Keep the CLI process
  // referenced until async command dispatch (including install cleanup) settles.
  // One maximal-delay timeout references the loop without waking a long-lived command (daemon,
  // session host) every minute; it is cleared when dispatch settles.
  const cliLifetimeKeepAlive = isCliDistIntegrityProbe ? null : setTimeout(() => undefined, 2_147_483_647);
  // Enabled before the command graph compiles; `--version`/help stay on their tiny graph.
  const runBootstrap = () => import('./cli/compileCache').then(({ enableShortLivedCliCompileCache }) => {
    if (!isCliDistIntegrityProbe) enableShortLivedCliCompileCache(readCliProcessArgs());
    return import('./cli/bootstrap');
  }).then(async ({ runCliBootstrap }) => {
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
      if (cliLifetimeKeepAlive !== null) clearTimeout(cliLifetimeKeepAlive);
    });
}
