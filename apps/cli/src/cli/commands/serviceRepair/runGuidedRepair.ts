import { spawnSync } from 'node:child_process';

import type { RepairFinding } from '@/diagnostics/doctorRepair';

import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { promptMultipleChoice } from '@/terminal/prompts/promptMultipleChoice';
import { bold, code, glyph, muted, severity } from '@/ui/format/styles';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

import {
  copyAuthExpiredForActiveProfile,
  copyAuthMissingForProfile,
  copyChannelSwitchRecommended,
  copyDevOnHostedCloudInformational,
  copyForFinding,
  copyForeignHome,
  copyLocalRelayOffChannelLeftovers,
  copyMachineNotRegisteredForProfile,
  copyMultiStackDetectedInformational,
  copyNoActiveStackYet,
  copyNoServersConfigured,
  copyServerProfileMissing,
  copyOrphanDaemonOnOtherChannel,
  formatFindingHeader,
  type ChannelSwitchChoice,
} from './prompts/_copy';

/**
 * Indent every non-empty body/guidance line so it sits visually under the
 * recommendation's `●`/`○` title. Empty lines stay empty so vertical
 * spacing inside a finding's body still works as written.
 */
const FINDING_BODY_INDENT = '    ';
function indentFindingBodyLines(lines: readonly string[]): string[] {
  return lines.map((line) => (line.length === 0 ? '' : `${FINDING_BODY_INDENT}${line}`));
}

/**
 * Invoke the **current** CLI binary — not whatever `happier` resolves to on
 * PATH — as a synchronous child process with the given arguments. Delegates
 * to `buildHappyCliSubprocessLaunchSpec` so we get the same resolution logic
 * used by the rest of the codebase:
 *
 *  - Bypasses the shim wrapper (`bin/happier.mjs`, `happier.cmd`) — important
 *    for Windows where the .cmd wrapper is argv[1].
 *  - Resolves the packaged entrypoint (`dist/index.mjs`) and bundled
 *    single-executable / tsx-dev fallbacks for dev variants.
 *  - Passes the runtime-matched Node/Bun launcher plus the same
 *    `--no-warnings --no-deprecation` flags the wrapper would have used.
 *  - Inherits stdio so command output streams live to the user.
 */
function runCliCommand(args: readonly string[]): boolean {
  let launchSpec: ReturnType<typeof buildHappyCliSubprocessLaunchSpec>;
  try {
    launchSpec = buildHappyCliSubprocessLaunchSpec([...args]);
  } catch {
    // Subprocess entrypoint couldn't be resolved (no packaged dist, no
    // bundled binary, no tsx fallback). Downgrade to a non-zero result so
    // the caller surfaces the same retry-manually warning as a failing exit.
    return false;
  }
  const env = launchSpec.env
    ? { ...process.env, ...launchSpec.env }
    : process.env;
  const result = spawnSync(launchSpec.filePath, launchSpec.args, {
    stdio: 'inherit',
    env,
  });
  return result.status === 0;
}

/**
 * Walks the findings in canonical order, printing each finding's explanation
 * and asking a single yes/no per actionable finding.
 *
 * Returns `true` if the caller should apply the underlying repair plan
 * (i.e. the user accepted at least one automatic-startup finding).
 *
 * First-cut scope:
 *  - foreign_home:       informational only (printed, no prompt)
 *  - automatic_startup_*: prompt per finding; any accepted → apply plan once
 *  - running_daemon_*:   print copy + one-line next-step guidance (no auto-apply yet)
 *  - local_relay_*:      print copy + one-line next-step guidance (no auto-apply yet)
 *
 * Per-finding dispatch for running-daemon and local-relay actions will arrive
 * in a follow-up; today's behavior mirrors the existing plan-apply path.
 */
export async function runGuidedRepair(params: Readonly<{
  findings: readonly RepairFinding[];
  currentCli: Readonly<{ releaseChannel: string; version: string; invoker: string }>;
}>): Promise<boolean> {
  let acceptedAutomaticStartup = false;
  let recommendationsHeaderPrinted = false;
  let anyFindingRendered = false;
  // Print the "Recommendations" header once, just before we start walking
  // actionable findings — it visually separates the report sections above
  // (Current CLI / Background services / Local relays / Authentication) from
  // the action items below, so prompts don't feel lost in the middle of the
  // output.
  const printRecommendationsHeaderOnce = () => {
    if (recommendationsHeaderPrinted) return;
    recommendationsHeaderPrinted = true;
    console.log('');
    console.log(bold('Recommendations'));
  };
  // Blank line BETWEEN successive findings (but not before the first one, so
  // the header and first recommendation sit together). Call once at the top
  // of every finding's render block.
  const separateFromPreviousFinding = () => {
    if (anyFindingRendered) console.log('');
    anyFindingRendered = true;
  };

  for (const finding of params.findings) {
    // Do NOT print the Recommendations header at the top of every iteration —
    // some findings (auth, informational) produce no output, and printing the
    // header unconditionally leaves a dangling "Recommendations\n" with
    // nothing under it when every finding falls through. Each branch that
    // actually emits content calls `printRecommendationsHeaderOnce()` right
    // before its first console.log.
    // `channel_switch_recommended` is special: it's a multi-choice prompt
    // (Switch / Keep / Replace / Parallel) instead of a Y/n. We still render
    // the standard `●`-bullet header so the finding looks like every other
    // recommendation in the list, then defer to the multi-choice prompt for
    // the body+question.
    if (finding.kind === 'channel_switch_recommended') {
      printRecommendationsHeaderOnce();
      separateFromPreviousFinding();
      for (const line of formatFindingHeader(finding)) console.log(line);
      const choice = await promptChannelSwitch(finding);
      const ok = await dispatchChannelSwitch(choice, finding, params.currentCli);
      if (ok) {
        console.log(`${FINDING_BODY_INDENT}${glyph.success()} done. Re-run ${code(`${params.currentCli.invoker} doctor repair`)} to verify.`);
        return false;          // stop the walk — the rest would be stale
      }
      if (choice === 'keep') continue;  // user declined — fall through to other findings
      console.log(`${FINDING_BODY_INDENT}${glyph.error()} ${severity.error('failed')} — you can retry manually`);
      continue;
    }

    if (finding.kind === 'automatic_startup_foreign_home') {
      printRecommendationsHeaderOnce();
      separateFromPreviousFinding();
      for (const line of formatFindingHeader(finding)) console.log(line);
      const lines = copyForeignHome(finding, params.currentCli.invoker);
      for (const line of indentFindingBodyLines(lines)) console.log(line);
      continue;
    }

    // `machine_not_registered_for_profile` is borderline: the fix is just
    // "start the daemon which will register". Offer to run it automatically
    // instead of asking the user to copy-paste a command.
    if (finding.kind === 'machine_not_registered_for_profile') {
      printRecommendationsHeaderOnce();
      separateFromPreviousFinding();
      for (const line of formatFindingHeader(finding)) console.log(line);
      const lines = guidanceLinesFor(finding, params.currentCli.invoker);
      if (lines) for (const line of indentFindingBodyLines(lines)) console.log(line);
      const yes = await promptConfirmYesNo(`${FINDING_BODY_INDENT}${bold('Start the daemon now to register this machine?')}`, { default: 'yes' });
      if (yes) {
        const ok = runCliCommand(['daemon', 'start']);
        if (ok) {
          console.log(`${FINDING_BODY_INDENT}${glyph.success()} done.`);
        } else {
          console.log(`${FINDING_BODY_INDENT}${glyph.error()} ${severity.error('failed')} — retry: ${code(`${params.currentCli.invoker} daemon start`)}`);
        }
      }
      continue;
    }

    // Informational / manual-guidance findings: print the copy, no prompt.
    const guidance = guidanceLinesFor(finding, params.currentCli.invoker);
    if (guidance) {
      printRecommendationsHeaderOnce();
      separateFromPreviousFinding();
      for (const line of formatFindingHeader(finding)) console.log(line);
      for (const line of indentFindingBodyLines(guidance)) console.log(line);
      continue;
    }

    const copy = copyForFinding(finding, params.currentCli);
    if (!copy) continue;

    printRecommendationsHeaderOnce();
    separateFromPreviousFinding();
    for (const line of formatFindingHeader(finding)) console.log(line);
    for (const line of indentFindingBodyLines(copy.body)) console.log(line);

    // The Y/n prompt is indented to the same column as the body lines, so
    // the prompt visually belongs to the finding above it.
    const answer = await promptConfirmYesNo(`${FINDING_BODY_INDENT}${bold(copy.question)}`, { default: copy.default });
    if (!answer) continue;

    if (finding.kind.startsWith('automatic_startup_')) {
      acceptedAutomaticStartup = true;
      continue;
    }
    // Non-automatic-startup findings: dispatch by spawning the current CLI
    // with the right subcommand. The sub-CLI's output streams to stdout via
    // `stdio: 'inherit'`; our `✓/✗` result prints immediately after with no
    // blank line, so it reads as the conclusion of the action, not a
    // detached status update.
    const ok = dispatchFindingAction(finding);
    if (ok) {
      console.log(`${FINDING_BODY_INDENT}${glyph.success()} done.`);
    } else {
      const hint = retryHintFor(finding, params.currentCli.invoker);
      console.log(`${FINDING_BODY_INDENT}${glyph.error()} ${severity.error('failed')} — ${hint}`);
    }
  }

  return acceptedAutomaticStartup;
}

function guidanceLinesFor(finding: RepairFinding, invoker: string): readonly string[] | null {
  switch (finding.kind) {
    case 'no_active_stack_yet':
      return copyNoActiveStackYet(finding, invoker);
    case 'no_servers_configured':
      return copyNoServersConfigured(invoker);
    case 'server_profile_missing':
      return copyServerProfileMissing(finding, invoker);
    // Auth findings are rendered inline in the Authentication report section
    // (sections/renderAuthentication.ts) with per-profile sub-lines telling
    // the user exactly what to run. Skipping them here avoids duplicated
    // per-profile blocks in the guided walk output.
    case 'auth_missing_for_profile':
    case 'auth_expired_for_active_profile':
      return null;
    case 'machine_not_registered_for_profile':
      return copyMachineNotRegisteredForProfile(finding, invoker);
    case 'dev_on_hosted_cloud_informational':
      return copyDevOnHostedCloudInformational(invoker);
    case 'multi_stack_detected_informational':
      return copyMultiStackDetectedInformational(finding);
    case 'orphan_daemon_on_other_channel':
      return copyOrphanDaemonOnOtherChannel(finding);
    case 'local_relay_off_channel_leftovers':
      // Already shown in the `Local relays` section above — repeating the
      // same list as a recommendation is noise. The top-of-report bullet
      // ("You have N local relays installed for other release channels")
      // remains, so the user still sees the fact, just not duplicated.
      return null;
    default:
      return null;
  }
}

async function promptChannelSwitch(finding: Extract<RepairFinding, { kind: 'channel_switch_recommended' }>): Promise<ChannelSwitchChoice> {
  const { body } = copyChannelSwitchRecommended(finding);
  console.log('');
  for (const line of body) console.log(line);
  return promptMultipleChoice<ChannelSwitchChoice>(bold('Choice?'), [
    { id: 'switch',   keys: ['y', 'yes'],       short: 'Y' },
    { id: 'keep',     keys: ['n', 'no'],        short: 'n' },
    { id: 'replace',  keys: ['r', 'replace'],   short: 'r' },
    { id: 'parallel', keys: ['p', 'parallel'],  short: 'p' },
  ], { defaultId: 'switch' });
}

async function dispatchChannelSwitch(
  choice: ChannelSwitchChoice,
  finding: Extract<RepairFinding, { kind: 'channel_switch_recommended' }>,
  currentCli: Readonly<{ releaseChannel: string; version: string; invoker: string }>,
): Promise<boolean> {
  const fromChannel = finding.fromStack.releaseChannel;
  switch (choice) {
    case 'keep':
      console.log('');
      console.log(muted(`Keeping the ${fromChannel} stack active. The ${finding.toChannel} CLI stays available via \`h${finding.toChannel}\` for occasional use.`));
      return true;
    case 'switch': {
      // Stop the old daemon (if any), then start a daemon with the current CLI.
      if (finding.fromStack.runningDaemon) {
        const daemon = finding.fromStack.runningDaemon;
        runCliCommand(['daemon', 'stop', '--server-id', daemon.serverId, '--pid', String(daemon.pid)]);
      }
      const started = runCliCommand(['daemon', 'start']);
      if (!started) return false;
      if (!finding.targetChannelHasLocalRelay && finding.fromStack.localRelay) {
        // Offer to install the matching-channel local relay since the user
        // was using local relays before.
        console.log('');
        console.log(muted(`Your ${fromChannel} stack used a local relay.`));
        const yes = await promptConfirmYesNo(
          bold(`Install a local ${finding.toChannel} relay now?`),
          { default: 'yes' },
        );
        if (yes) runCliCommand(['relay', 'host', 'install', '--channel', currentCli.releaseChannel, '--yes']);
      }
      return true;
    }
    case 'replace': {
      // Uninstall the old stack's automatic-startup entry + stop the daemon.
      if (finding.fromStack.runningDaemon) {
        const daemon = finding.fromStack.runningDaemon;
        runCliCommand(['daemon', 'stop', '--server-id', daemon.serverId, '--pid', String(daemon.pid)]);
      }
      if (finding.fromStack.automaticStartup) {
        runCliCommand(['service', 'uninstall', '--yes']);
      }
      const started = runCliCommand(['daemon', 'start']);
      return started;
    }
    case 'parallel': {
      console.log('');
      console.log(muted(`Parallel setup needs a different server profile for the ${finding.toChannel} stack to avoid colliding with ${fromChannel}.`));
      console.log(muted('Configure a separate profile first, then run:'));
      console.log(`  ${currentCli.invoker} server add <${finding.toChannel}-server-url>`);
      console.log(`  ${currentCli.invoker} daemon start`);
      return true;
    }
  }
}

function dispatchFindingAction(finding: RepairFinding): boolean {
  switch (finding.kind) {
    case 'cli_self_update_available':
      return runCliCommand(cliSelfUpdateArgs(finding.releaseChannel));
    case 'running_daemon_cli_mismatch':
      // Three cases:
      //   * `service-restart`: a managing service exists on the same relay
      //     profile on the current CLI's channel. Restart the service so it
      //     takes over cleanly (avoids "A background service is already
      //     installed for the selected relay" guard in daemon-takeover).
      //   * `daemon-takeover`: same channel, older version. Takeover respawns
      //     the daemon with the current CLI.
      //   * `daemon-stop`: cross-channel orphan. Takeover can't switch
      //     channels, so we just stop. User decides whether to start a
      //     current-channel daemon afterwards.
      if (finding.recoveryStrategy === 'service-restart') {
        // Always pass --takeover here: by construction, this branch fires
        // because a different-CLI / different-channel daemon is holding the
        // same profile as the current-channel service. Without --takeover
        // the service-restart refuses and we leave the user in exactly the
        // confusing state they ran repair to fix. `service restart --takeover`
        // is safe to run when no manual conflict exists — it's a no-op in
        // that case.
        return runCliCommand(['service', 'restart', '--takeover']);
      }
      if (finding.recoveryStrategy === 'daemon-stop') {
        // Cross-channel replace: stop the old-channel daemon, then start a
        // fresh one using THIS CLI (which will be on the current channel).
        // `happier daemon start` spawns against the active relay profile, so
        // we end up with a current-channel daemon on the same profile the old
        // daemon was using. If the stop fails, skip the start.
        const stopped = runCliCommand([
          'daemon', 'stop',
          '--server-id', finding.daemon.serverId,
          '--pid', String(finding.daemon.pid),
        ]);
        if (!stopped) return false;
        return runCliCommand(['daemon', 'start']);
      }
      return runCliCommand(['daemon', 'restart', '--takeover']);
    case 'running_daemon_duplicate_profile': {
      // Stop the older daemon: prefer the one NOT started by automatic startup,
      // else the last one in the list.
      const ordered = [...finding.daemons].sort((a, b) =>
        (b.startedBy === 'automatic-startup' ? 1 : 0) - (a.startedBy === 'automatic-startup' ? 1 : 0),
      );
      const older = ordered[ordered.length - 1];
      return runCliCommand([
        'daemon', 'stop',
        '--server-id', finding.serverId,
        '--pid', String(older.pid),
      ]);
    }
    case 'local_relay_lane_missing':
      return runCliCommand(['relay', 'host', 'install', '--channel', finding.targetReleaseChannel, '--yes']);
    case 'local_relay_version_stale':
      return runCliCommand(['relay', 'host', 'install', '--channel', finding.entry.releaseChannel, '--yes']);
    case 'background_service_not_running':
      // `--takeover` is always safe here — it's a no-op when no conflict
      // exists, and it prevents `service start` from printing "A manually
      // started daemon is running" and exiting 0 on the rare case where a
      // manual daemon appeared between inventory snapshot and dispatch.
      return runCliCommand(['service', 'start', '--takeover']);
    case 'background_service_crash_looping': {
      // If a conflicting manual daemon was identified, stop it first — that
      // usually unblocks the crash loop (the service's next respawn, now
      // with `--takeover`, will succeed). After stopping the conflict, we
      // kick the service explicitly via `service restart` to speed up the
      // recovery instead of waiting for launchd's backoff.
      if (finding.conflictingDaemon) {
        const stopped = runCliCommand([
          'daemon', 'stop',
          '--server-id', finding.conflictingDaemon.serverId,
          '--pid', String(finding.conflictingDaemon.pid),
        ]);
        if (!stopped) return false;
        return runCliCommand(['service', 'restart']);
      }
      return runCliCommand(['service', 'restart']);
    }
    default:
      // Other findings (automatic-startup) are applied via the plan path after
      // the walk returns true. This function should only see dispatchable kinds.
      return false;
  }
}

function cliSelfUpdateArgs(channel: 'stable' | 'preview' | 'dev'): string[] {
  if (channel === 'preview') return ['self', 'update', '--preview'];
  if (channel === 'dev') return ['self', 'update', '--dev'];
  return ['self', 'update'];
}

/**
 * One-line actionable retry hint per finding kind. Shown after a dispatched
 * action exits non-zero so the user knows what to do next, tailored to the
 * actual thing that broke instead of a generic "retry manually."
 */
function retryHintFor(finding: RepairFinding, invoker: string): string {
  switch (finding.kind) {
    case 'running_daemon_cli_mismatch':
      if (finding.recoveryStrategy === 'service-restart') {
        return `see message above · retry: ${code(`${invoker} service restart --takeover`)}`;
      }
      if (finding.recoveryStrategy === 'daemon-takeover') {
        return `see message above · retry: ${code(`${invoker} daemon restart --takeover`)}`;
      }
      return `see message above · retry: ${code(`${invoker} daemon stop`)} then ${code(`${invoker} daemon start`)}`;
    case 'running_daemon_duplicate_profile':
      return `see message above · retry: ${code(`${invoker} daemon stop --server-id <id> --pid <pid>`)}`;
    case 'background_service_not_running':
      return `see message above · retry: ${code(`${invoker} service start --takeover`)}`;
    case 'background_service_crash_looping':
      return `see message above · inspect logs under ${code('~/.happier/logs/')}`;
    case 'local_relay_lane_missing':
    case 'local_relay_version_stale':
      return `see message above · retry: ${code(`${invoker} relay host install`)}`;
    case 'cli_self_update_available':
      return `see message above · retry: ${code(`${invoker} self update`)}`;
    default:
      return 'see message above — you can retry manually';
  }
}
