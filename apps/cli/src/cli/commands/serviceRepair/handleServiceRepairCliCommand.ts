import chalk from 'chalk';

import { applyBackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import { resolveDoctorRepairReport } from '@/diagnostics/doctorRepair';
import type { DoctorRepairReport } from '@/diagnostics/doctorRepair/types';
import { assertDaemonServiceModeSupported } from '@/daemon/service/assertDaemonServiceModeSupported';
import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import { bold, muted } from '@/ui/format/styles';
import { configuration } from '@/configuration';
import { getServerProfile } from '@/server/serverProfiles';

import { isInteractiveTerminal } from '../server/commandUtilities';
import { assertRepairPlanSystemUserAvailable, resolveBackgroundServiceRepairSystemUser } from './repairSystemUser';
import { renderDoctorRepairReport } from './renderDoctorRepairReport';
import { runGuidedRepair } from './runGuidedRepair';

function printMigrationBanner(params: Readonly<{ report: DoctorRepairReport }>): void {
  const activeProfile = params.report.authProfiles.find((p) => p.isActive);
  const serverUrl = activeProfile?.serverUrl ?? null;
  const channel = params.report.currentCli.releaseChannel;
  console.log('');
  console.log(bold('Migrating Happier to the new background-service model'));
  if (serverUrl) {
    console.log(muted(`Current default server: ${serverUrl} · CLI channel: ${channel}`));
  } else {
    console.log(muted(`CLI channel: ${channel}`));
  }
  console.log(muted('Older background services can be converged into a single default-server-following service.'));
}

function resolveModeFromText(raw: string, source: string): 'user' | 'system' {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'user' || value === 'system') return value;
  throw new Error(`Invalid ${source} value "${String(raw ?? '').trim()}" (expected user|system)`);
}
function parseRepairInvocation(argv: readonly string[]): Readonly<{
  execute: boolean;
  asJson: boolean;
  reportOnly: boolean;
  migrate: boolean;
  mode: 'user' | 'system';
  modeExplicit: boolean;
  systemUser: string;
  /**
   * `--server <selector>` / `--server=<selector>`: scope all findings to a
   * specific server profile. The selector is resolved using the same profile
   * lookup as other CLI server selectors (id, name, or relay URL). When set,
   * the report behaves as if the user had `happier server use <id>` first —
   * without mutating settings — so the absence of a profile, auth, machine
   * registration, automatic startup, or running daemon for that server all
   * surface as findings.
   */
  targetServerSelector: string | null;
}> {
  let mode: 'user' | 'system' | null = null;
  let systemUser = '';
  let targetServerSelector: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (arg === '--mode') {
      const next = String(argv[index + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --mode (expected user|system)');
      }
      mode = resolveModeFromText(next, '--mode');
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = resolveModeFromText(arg.slice('--mode='.length), '--mode');
      continue;
    }
    if (arg === '--system-user') {
      const next = String(argv[index + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --system-user');
      }
      systemUser = next.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--system-user=')) {
      systemUser = arg.slice('--system-user='.length).trim();
      continue;
    }
    if (arg === '--server') {
      const next = String(argv[index + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --server (expected a server profile id, name, or URL)');
      }
      targetServerSelector = next.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--server=')) {
      targetServerSelector = arg.slice('--server='.length).trim() || null;
    }
  }

  return {
    execute: argv.includes('--yes'),
    asJson: argv.includes('--json'),
    reportOnly: argv.includes('--report-only'),
    migrate: argv.includes('--migrate'),
    mode: mode ?? (String(process.env.HAPPIER_DAEMON_SERVICE_MODE ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user'),
    modeExplicit: mode !== null,
    systemUser: systemUser || String(process.env.HAPPIER_DAEMON_SERVICE_SYSTEM_USER ?? '').trim(),
    targetServerSelector,
  };
}

async function resolveRepairTargetServerId(selector: string | null): Promise<string | null> {
  const value = String(selector ?? '').trim();
  if (!value) return null;
  try {
    return (await getServerProfile(value)).id;
  } catch {
    // Preserve the absence-finding behavior introduced for `doctor repair
    // --server <id>`: when nothing matches, pass the raw selector through so
    // the report can render `server_profile_missing` for exactly what the
    // user typed.
    return value;
  }
}

function resolveCurrentPublicReleaseChannelLabel(): string | null {
  const value = String(configuration.publicReleaseRing ?? '').trim();
  if (!value) {
    return null;
  }
  return formatPublicReleaseChannelLabel(value);
}

function formatPublicReleaseChannelLabel(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const normalized = formatReleaseChannel(trimmed, { colored: false });
  return normalized ? normalized.toLowerCase() : null;
}

function resolveDefaultFollowingMatchesSelectedReleaseChannel(params: Readonly<{
  plan: BackgroundServiceRepairPlan;
  selectedReleaseChannelLabel: string | null;
}>): boolean | null {
  const selected = formatPublicReleaseChannelLabel(params.selectedReleaseChannelLabel);
  if (!selected) return null;
  const candidates = params.plan.existingServices
    .filter((service) => service.targetMode === 'default-following')
    .map((service) => formatPublicReleaseChannelLabel(service.releaseChannel))
    .filter((value): value is string => Boolean(value));
  if (candidates.length === 0) return null;
  return candidates.some((candidate) => candidate === selected);
}

function buildDoctorRepairJsonSnapshot(snapshot: DoctorSnapshot | null): Readonly<{
  daemonStatus: DoctorSnapshot['daemonStatus'] | null;
  relays: readonly NonNullable<NonNullable<NonNullable<DoctorSnapshot['relays']>['happier']>['relays'][number]>[];
  daemonRunning: boolean | null;
  daemonPid: number | null;
  daemonServiceManaged: boolean | null;
  daemonStartedWithPublicReleaseChannel: string | null;
  daemonStartedWithCliVersion: string | null;
  daemonCurrentInvocationMatches: boolean | null;
}> {
  const daemon = snapshot?.daemonStatus?.daemon;
  const currentCliVersion = String(configuration.currentCliVersion ?? '').trim();
  const currentPublicReleaseChannel = resolveCurrentPublicReleaseChannelLabel();
  const versionMismatch = Boolean(
    currentCliVersion
    && daemon?.startedWithCliVersion
    && currentCliVersion !== daemon.startedWithCliVersion,
  );
  const releaseChannelMismatch = Boolean(
    currentPublicReleaseChannel
    && daemon?.startedWithPublicReleaseChannel
    && currentPublicReleaseChannel !== daemon.startedWithPublicReleaseChannel,
  );

  return {
    daemonStatus: snapshot?.daemonStatus ?? null,
    relays: snapshot?.relays?.happier?.relays ?? [],
    daemonRunning: typeof daemon?.running === 'boolean' ? daemon.running : null,
    daemonPid: daemon?.pid ?? null,
    daemonServiceManaged: daemon?.serviceManaged ?? null,
    daemonStartedWithPublicReleaseChannel: daemon?.startedWithPublicReleaseChannel ?? null,
    daemonStartedWithCliVersion: daemon?.startedWithCliVersion ?? null,
    daemonCurrentInvocationMatches: daemon?.running
      ? !versionMismatch && !releaseChannelMismatch
      : null,
  };
}

export async function handleServiceRepairCliCommand(params: Readonly<{
  argv: readonly string[];
  commandPath: string;
}>): Promise<void> {
  const parsed = parseRepairInvocation(params.argv);
  const systemUser = resolveBackgroundServiceRepairSystemUser({
    preferredMode: parsed.mode,
    systemUser: parsed.systemUser,
  });
  // `--migrate` (explicit, discoverable) or `HAPPIER_INSTALLER_MIGRATION=1`
  // (legacy env hook used by the self-update + install-payload migration path)
  // both enable migration-scope auto-apply for the 0.2.3 convergence findings.
  const onMigration = parsed.migrate
    || String(process.env.HAPPIER_INSTALLER_MIGRATION ?? '').trim() === '1';
  const targetServerId = await resolveRepairTargetServerId(parsed.targetServerSelector);
  const { report, plan, snapshot, runtime } = await resolveDoctorRepairReport({
    preferredMode: parsed.mode,
    systemUser,
    onMigration,
    targetServerId,
  });
  assertDaemonServiceModeSupported(runtime.platform, parsed.mode);
  if (parsed.modeExplicit && parsed.mode === 'system' && runtime.platform === 'linux' && runtime.uid !== 0) {
    throw new Error('Root privileges are required for system mode automatic startup repair');
  }
  const requiresRootForPlan = runtime.platform === 'linux'
    && runtime.uid !== 0
    && plan.actions.some((action) => action.kind === 'remove-service'
      ? action.service.mode === 'system'
      : action.mode === 'system');
  // The legacy ownership-note block has been superseded: its information is now
  // conveyed (accurately, per finding) by the Currently running section and the
  // per-finding prompts. The JSON compat envelope keeps a `warning` field for
  // older installer shells that read it; we emit an empty string there.
  const ownershipWarningText: string | undefined = undefined;
  const repairSnapshotJson = buildDoctorRepairJsonSnapshot(snapshot);
  const currentCliReleaseChannel = resolveCurrentPublicReleaseChannelLabel();
  const defaultFollowingMatchesSelectedReleaseChannel = resolveDefaultFollowingMatchesSelectedReleaseChannel({
    plan,
    selectedReleaseChannelLabel: currentCliReleaseChannel,
  });

  if (parsed.asJson) {
    if (!parsed.execute) {
      console.log(JSON.stringify({
        ok: true,
        executed: false,
        report,
        schemaVersion: 2,
        defaultFollowingMatchesSelectedReleaseChannel,
        existingServices: plan.existingServices,
        actions: plan.actions,
        manualWarnings: plan.manualWarnings,
        warning: ownershipWarningText,
        ...repairSnapshotJson,
      }, null, 2));
      return;
    }

    if (requiresRootForPlan) {
      throw new Error('Root privileges are required to apply system mode automatic startup repair actions');
    }
    assertRepairPlanSystemUserAvailable({ plan, systemUser });

    const result = await applyBackgroundServiceRepairPlan(plan, {
      platform: runtime.platform,
      systemUser,
      uid: runtime.uid,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    });
    console.log(JSON.stringify({
      ok: true,
      executed: true,
      report,
      schemaVersion: 2,
      defaultFollowingMatchesSelectedReleaseChannel,
      executedActions: result.executedActions,
      manualWarnings: plan.manualWarnings,
      warning: ownershipWarningText,
      ...repairSnapshotJson,
    }, null, 2));
    return;
  }

  if (!parsed.execute) {
    if (parsed.reportOnly) {
      // --report-only is streamed by the installer in non-interactive
      // contexts (`curl | bash`). Include the CTA footer so users who can't
      // answer prompts know there's a follow-up command to run.
      if (onMigration) printMigrationBanner({ report });
      console.log(renderDoctorRepairReport(report, { includeInteractiveFooter: true }).join('\n'));
      return;
    }

    if (onMigration) printMigrationBanner({ report });
    console.log(renderDoctorRepairReport(report).join('\n'));
    if (report.findings.length === 0 || !isInteractiveTerminal()) {
      return;
    }

    const shouldApply = await runGuidedRepair({
      findings: report.findings,
      currentCli: {
        releaseChannel: report.currentCli.releaseChannel,
        version: report.currentCli.version,
        invoker: report.currentCli.invoker,
      },
    });
    if (!shouldApply) {
      return;
    }
  }

  if (requiresRootForPlan) {
    throw new Error('Root privileges are required to apply system mode automatic startup repair actions');
  }
  assertRepairPlanSystemUserAvailable({ plan, systemUser });

  if (onMigration && parsed.execute) {
    // `--migrate --yes` ran headlessly (self-update / install-payload promotion).
    // Print a banner so the user sees why these service actions are happening.
    printMigrationBanner({ report });
  }

  const result = await applyBackgroundServiceRepairPlan(plan, {
    platform: runtime.platform,
    systemUser,
    uid: runtime.uid,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
  });
  // Only print this summary when something was actually applied. A zero
  // count is misleading after an interactive walk where dispatched actions
  // (service restart, daemon takeover, etc.) ran outside the plan path.
  if (result.executedActions.length > 0) {
    console.log(chalk.green('✓'), `Applied ${result.executedActions.length} automatic startup repair action(s).`);
  }

  // Only meaningful in `--yes` (non-interactive) mode: list findings that
  // need the user to be prompted but couldn't be (because --yes applies
  // only `autoApplyWithoutPrompt=true` findings). In interactive mode the
  // user just walked through every finding via the guided walk, so this
  // message would lie ("run `happier doctor repair`" — they just did).
  if (parsed.execute) {
    const unappliedFindings = report.findings.filter((f) => f.autoApplyWithoutPrompt === false);
    if (unappliedFindings.length > 0) {
      console.log('');
      const noun = unappliedFindings.length === 1 ? 'finding needs' : 'findings need';
      console.log(chalk.yellow(`${unappliedFindings.length} ${noun} interactive confirmation — run \`happier doctor repair\` to address ${unappliedFindings.length === 1 ? 'it' : 'them'}.`));
    }
  }
}
