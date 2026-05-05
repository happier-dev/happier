import type { HappierRuntimeWarning, HappierService } from '@happier-dev/cli-common/happierRuntime';
import {
  normalizePublicReleaseRingId,
  resolvePublicReleaseRingLabelForId,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

import type { BackgroundServiceRepairAction } from '@/diagnostics/backgroundServiceRepair';

import type {
  AutomaticStartupEntry,
  BuildServiceRepairReportParams,
  ServiceRepairFinding,
  LocalRelayEntry,
  ServiceRepairReport,
  ServiceRepairTargetMode,
  ServiceRepairDaemonStatusSnapshot,
  RunningDaemonEntry,
  AuthProfileEntry,
  StackEntry,
  BackgroundServiceHealthSummary,
} from './types';

function normalizeTargetMode(value: unknown): ServiceRepairTargetMode {
  if (value === 'default-following' || value === 'legacy-pinned') return value;
  return 'pinned';
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeReleaseChannelForComparison(value: unknown): string | null {
  const publicReleaseRingId = normalizePublicReleaseRingId(value);
  return publicReleaseRingId || normalizeText(value);
}

function normalizePublicReleaseChannelForAction(value: unknown): PublicReleaseRingId | string | null {
  const publicReleaseRingId = normalizePublicReleaseRingId(value);
  return publicReleaseRingId || normalizeText(value);
}

function formatReleaseChannelLabel(value: unknown): string {
  const publicReleaseRingId = normalizePublicReleaseRingId(value);
  if (publicReleaseRingId) {
    return resolvePublicReleaseRingLabelForId(publicReleaseRingId);
  }
  return normalizeText(value) ?? 'unknown';
}

function releaseChannelsMatch(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeReleaseChannelForComparison(left);
  const normalizedRight = normalizeReleaseChannelForComparison(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft === normalizedRight;
}

function normalizeStartupEntry(raw: unknown): AutomaticStartupEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Readonly<Record<string, unknown>>;
  const label = normalizeText(entry.label);
  if (!label) return null;
  const definitionPath = normalizeText(entry.definitionPath) ?? normalizeText(entry.installedPath) ?? normalizeText(entry.path);
  const scope = entry.scope === 'system' || entry.mode === 'system'
    ? 'system'
    : entry.scope === 'user' || entry.mode === 'user'
      ? 'user'
      : null;
  const platform = entry.platform === 'darwin' || entry.platform === 'linux' || entry.platform === 'win32'
    ? entry.platform
    : null;
  return {
    id: normalizeText(entry.id),
    label,
    platform,
    backend: normalizeText(entry.backend),
    scope,
    releaseChannel: normalizeText(entry.releaseChannel) ?? normalizeText(entry.ring),
    targetMode: normalizeTargetMode(entry.targetMode),
    instanceId: normalizeText(entry.instanceId) ?? normalizeText(entry.serverId),
    definitionPath,
    installed: typeof entry.installed === 'boolean' ? entry.installed : null,
    running: typeof entry.running === 'boolean' ? entry.running : null,
  };
}

function normalizeDiscoveredService(service: HappierService): AutomaticStartupEntry | null {
  if (service.serviceType !== 'daemon') return null;
  return normalizeStartupEntry({
    id: service.id,
    label: service.label,
    platform: service.platform,
    backend: service.backend,
    scope: service.scope,
    releaseChannel: service.ring,
    targetMode: service.targetMode,
    instanceId: service.instanceId,
    definitionPath: service.definitionPath,
    installed: service.installed,
    running: service.running,
  });
}

function startupEntryKey(entry: AutomaticStartupEntry): string {
  return entry.id ?? entry.definitionPath ?? entry.label;
}

function dedupeStartupEntries(entries: readonly AutomaticStartupEntry[]): AutomaticStartupEntry[] {
  const byKey = new Map<string, AutomaticStartupEntry>();
  for (const entry of entries) {
    byKey.set(startupEntryKey(entry), entry);
  }
  return [...byKey.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function firstDefaultFollowingEntry(entries: readonly AutomaticStartupEntry[]): AutomaticStartupEntry | null {
  return entries.find((entry) => entry.targetMode === 'default-following') ?? entries[0] ?? null;
}

function findEntryByLabel(
  entries: readonly AutomaticStartupEntry[],
  label: string | null,
): AutomaticStartupEntry | null {
  if (!label) return null;
  return entries.find((entry) => entry.label === label) ?? null;
}

function isSameManagedSlot(left: AutomaticStartupEntry | null, right: AutomaticStartupEntry | null): boolean {
  if (!left || !right) return false;
  if (left.id && right.id && left.id === right.id) return true;
  if (left.definitionPath && right.definitionPath && left.definitionPath === right.definitionPath) return true;
  return left.label === right.label
    && left.targetMode === right.targetMode
    && (left.instanceId ?? '') === (right.instanceId ?? '');
}

function warningFindingKind(code: HappierRuntimeWarning['code']): ServiceRepairFinding['kind'] {
  if (code === 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE') {
    return 'automatic_startup_duplicate_default_following';
  }
  if (code === 'CONFLICTING_PINNED_DAEMON_SERVICES_FOR_SERVER') {
    return 'automatic_startup_duplicate_pinned_same_server';
  }
  if (code === 'LEGACY_PINNED_DAEMON_SERVICE' || code === 'DEFAULT_AND_PINNED_DAEMON_SERVICE_CONFLICT') {
    return 'automatic_startup_legacy_pinned_current_server';
  }
  if (code === 'ORPHAN_DAEMON_SERVICE') {
    return 'automatic_startup_stale_definition';
  }
  if (code === 'DAEMON_STARTED_WITH_DIFFERENT_CLI') {
    return 'running_daemon_cli_mismatch';
  }
  return 'cli_self_update_available';
}

function actionForBackgroundPlanAction(planAction: BackgroundServiceRepairAction): ServiceRepairFinding['actions'][number] {
  return {
    kind: 'background-service-plan',
    planAction,
  };
}

function buildActionFindings(params: Readonly<{
  actions: readonly BackgroundServiceRepairAction[];
  automaticStartup: readonly AutomaticStartupEntry[];
  currentReleaseChannel: string;
}>): ServiceRepairFinding[] {
  return params.actions.map((action, index) => {
    if (action.kind === 'remove-service') {
      const actionEntry = normalizeStartupEntry(action.service);
      const entry = actionEntry
        ? params.automaticStartup.find((candidate) => startupEntryKey(candidate) === startupEntryKey(actionEntry)) ?? actionEntry
        : null;
      return {
        id: `background-service-action:${index}`,
        kind: entry?.targetMode === 'default-following'
          ? 'automatic_startup_version_stale'
          : 'automatic_startup_legacy_pinned_current_server',
        severity: 'warning',
        title: `Repair ${entry?.label ?? 'background service'}`,
        diagnostic: entry?.definitionPath ?? null,
        warningCode: null,
        entry,
        targetMode: entry?.targetMode ?? null,
        actions: [actionForBackgroundPlanAction(action)],
      };
    }

    return {
      id: `background-service-action:${index}`,
      kind: 'automatic_startup_missing',
      severity: 'warning',
      title: `Install one default background service for ${formatReleaseChannelLabel(params.currentReleaseChannel)}`,
      diagnostic: `mode=${action.mode}`,
      warningCode: null,
      entry: null,
      targetMode: 'default-following',
      actions: [actionForBackgroundPlanAction(action)],
    };
  });
}

function resolveDaemonMismatchClassification(params: Readonly<{
  daemonStatus: ServiceRepairDaemonStatusSnapshot | null | undefined;
  currentReleaseChannel: string;
}>): Pick<ServiceRepairFinding, 'driftKind' | 'recoveryStrategy'> {
  const daemonReleaseChannel = normalizeText(params.daemonStatus?.daemon.startedWithPublicReleaseChannel);
  if (
    daemonReleaseChannel !== null
    && params.currentReleaseChannel.length > 0
    && !releaseChannelsMatch(daemonReleaseChannel, params.currentReleaseChannel)
  ) {
    return {
      driftKind: 'cross-channel',
      recoveryStrategy: 'daemon-stop',
    };
  }

  return {
    driftKind: 'version-only',
    recoveryStrategy: params.daemonStatus?.daemon.serviceManaged === true
      ? 'service-restart'
      : 'daemon-takeover',
  };
}

function buildWarningFindings(params: Readonly<{
  warnings: readonly HappierRuntimeWarning[];
  automaticStartup: readonly AutomaticStartupEntry[];
  currentReleaseChannel: string;
  daemonStatus?: ServiceRepairDaemonStatusSnapshot | null;
}>): ServiceRepairFinding[] {
  return params.warnings.map((warning, index) => {
    const kind = warningFindingKind(warning.code);
    const isDaemonMismatch = kind === 'running_daemon_cli_mismatch';
    const entry = isDaemonMismatch
      ? findEntryByLabel(params.automaticStartup, normalizeText(params.daemonStatus?.daemon.serviceLabel))
        ?? firstDefaultFollowingEntry(params.automaticStartup)
      : firstDefaultFollowingEntry(params.automaticStartup);
    return {
      id: `runtime-warning:${warning.code}:${index}`,
      kind,
      severity: warning.severity,
      title: warning.message,
      diagnostic: warning.repairCommands.length > 0 ? `Suggested command: ${warning.repairCommands[0]}` : null,
      warningCode: warning.code,
      entry,
      targetMode: entry?.targetMode ?? null,
      ...(isDaemonMismatch ? resolveDaemonMismatchClassification({
        daemonStatus: params.daemonStatus,
        currentReleaseChannel: params.currentReleaseChannel,
      }) : {}),
      actions: warning.repairCommands.map((command) => ({
        kind: 'run-command' as const,
        command,
      })),
    };
  });
}

function buildStackFindings(params: Readonly<{
  stacks?: readonly StackEntry[];
  currentReleaseChannel: string;
  publicServerUrl: string | null;
}>): ServiceRepairFinding[] {
  if (!params.stacks) {
    return [];
  }
  if (params.stacks.length === 0) {
    return [{
      id: 'stack:no-active-stack',
      kind: 'no_active_stack_yet',
      severity: 'warning',
      title: 'No active Relay stack is configured.',
      diagnostic: 'Run setup to select a Relay and configure this computer.',
      warningCode: null,
      entry: null,
      targetMode: null,
      actions: [{ kind: 'run-setup', command: 'happier setup' }],
    }];
  }

  const findings: ServiceRepairFinding[] = [];
  const activeStack = params.stacks.find((stack) => stack.active) ?? null;
  const activeReleaseChannel = normalizeText(activeStack?.releaseChannel);
  const activeReleaseChannelForAction = normalizePublicReleaseChannelForAction(activeReleaseChannel);
  if (
    activeStack
    && activeReleaseChannel
    && activeReleaseChannelForAction
    && params.currentReleaseChannel
    && !releaseChannelsMatch(activeReleaseChannel, params.currentReleaseChannel)
  ) {
    const activeReleaseChannelLabel = formatReleaseChannelLabel(activeReleaseChannelForAction);
    findings.push({
      id: `stack:channel-switch:${activeStack.id}`,
      kind: 'channel_switch_recommended',
      severity: 'warning',
      title: `Switch the CLI release channel to ${activeReleaseChannelLabel}.`,
      diagnostic: `Active stack=${activeStack.id}`,
      warningCode: null,
      entry: null,
      targetMode: null,
      actions: [{
        kind: 'switch-release-channel',
        releaseChannel: activeReleaseChannelForAction,
        command: `happier self release-channel use ${activeReleaseChannelLabel}`,
      }],
    });
  }

  if (params.stacks.length > 1) {
    findings.push({
      id: 'stack:multiple',
      kind: 'multi_stack_detected_informational',
      severity: 'info',
      title: 'Multiple Relay stacks are configured.',
      diagnostic: params.stacks.map((stack) => stack.id).join(', '),
      warningCode: null,
      entry: null,
      targetMode: null,
      actions: [],
    });
  }

  const publicServerUrl = normalizeText(params.publicServerUrl);
  if (
    normalizeReleaseChannelForComparison(params.currentReleaseChannel) === 'publicdev'
    && publicServerUrl !== null
    && /(^|\.)happier\.dev(\/|$)/iu.test(publicServerUrl.replace(/^https?:\/\//iu, ''))
  ) {
    findings.push({
      id: 'stack:dev-on-hosted-cloud',
      kind: 'dev_on_hosted_cloud_informational',
      severity: 'info',
      title: 'The dev CLI is using hosted Happier Cloud.',
      diagnostic: publicServerUrl,
      warningCode: null,
      entry: null,
      targetMode: null,
      actions: [],
    });
  }

  return findings;
}

function resolveAuthState(profile: AuthProfileEntry): NonNullable<AuthProfileEntry['authState']> {
  if (profile.authState === 'authenticated' || profile.authState === 'missing' || profile.authState === 'expired') {
    return profile.authState;
  }
  if (profile.authenticated === true) return 'authenticated';
  if (profile.authenticated === false) return 'missing';
  return 'unknown';
}

function buildAuthFindings(authProfiles?: readonly AuthProfileEntry[]): ServiceRepairFinding[] {
  if (!authProfiles) {
    return [];
  }
  if (authProfiles.length === 0) {
    return [{
      id: 'auth:no-servers-configured',
      kind: 'no_servers_configured',
      severity: 'warning',
      title: 'No Relay profiles are configured.',
      diagnostic: 'Run setup to add a Relay profile.',
      warningCode: null,
      entry: null,
      targetMode: null,
      actions: [{ kind: 'run-setup', command: 'happier setup' }],
    }];
  }

  const targetProfiles = authProfiles.some((profile) => profile.active)
    ? authProfiles.filter((profile) => profile.active)
    : authProfiles;
  return targetProfiles.flatMap((profile): ServiceRepairFinding[] => {
    const authState = resolveAuthState(profile);
    if (authState === 'missing' || profile.authenticated === false) {
      return [{
        id: `auth:missing:${profile.id}`,
        kind: 'auth_missing_for_profile' as const,
        severity: 'warning' as const,
        title: `Sign in to Relay profile ${profile.id}.`,
        diagnostic: null,
        warningCode: null,
        entry: null,
        targetMode: null,
        actions: [{
          kind: 'run-auth-login' as const,
          profileId: profile.id,
          command: 'happier auth login',
        }],
      }];
    }
    if (authState === 'expired') {
      return [{
        id: `auth:expired:${profile.id}`,
        kind: 'auth_expired_for_active_profile' as const,
        severity: 'warning' as const,
        title: `Refresh sign-in for Relay profile ${profile.id}.`,
        diagnostic: null,
        warningCode: null,
        entry: null,
        targetMode: null,
        actions: [{
          kind: 'run-auth-login' as const,
          profileId: profile.id,
          command: 'happier auth login',
        }],
      }];
    }
    if (profile.authenticated === true && profile.machineRegistered === false) {
      return [{
        id: `auth:machine-not-registered:${profile.id}`,
        kind: 'machine_not_registered_for_profile' as const,
        severity: 'warning' as const,
        title: `Register this computer with Relay profile ${profile.id}.`,
        diagnostic: null,
        warningCode: null,
        entry: null,
        targetMode: null,
        actions: [{
          kind: 'register-machine' as const,
          profileId: profile.id,
          command: 'happier setup',
        }],
      }];
    }
    return [];
  });
}

function buildCurrentlyRunningDaemonEntries(params: Readonly<{
  daemonStatus: ServiceRepairDaemonStatusSnapshot | null | undefined;
  automaticStartup: readonly AutomaticStartupEntry[];
}>): RunningDaemonEntry[] {
  const daemon = params.daemonStatus?.daemon;
  if (!daemon?.running) {
    return [];
  }
  const serviceLabel = normalizeText(daemon.serviceLabel);
  const managedEntry = serviceLabel
    ? params.automaticStartup.find((entry) => entry.label === serviceLabel) ?? null
    : null;
  return [{
    label: serviceLabel,
    releaseChannel: normalizeText(daemon.startedWithPublicReleaseChannel),
    version: normalizeText(daemon.startedWithCliVersion),
    serviceManaged: typeof daemon.serviceManaged === 'boolean' ? daemon.serviceManaged : null,
    managedByEntryId: managedEntry ? startupEntryKey(managedEntry) : null,
  }];
}

function isCurrentChannelStartupEntry(entry: AutomaticStartupEntry, currentReleaseChannel: string): boolean {
  return entry.targetMode === 'default-following'
    && releaseChannelsMatch(entry.releaseChannel, currentReleaseChannel);
}

function formatHealthDiagnostic(health: BackgroundServiceHealthSummary): string | null {
  const parts = [
    health.details?.state ? `state=${health.details.state}` : null,
    typeof health.details?.restartCount === 'number' ? `restartCount=${health.details.restartCount}` : null,
    typeof health.details?.lastExitStatus === 'number' ? `lastExitStatus=${health.details.lastExitStatus}` : null,
    health.reason ? `reason=${health.reason}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

function buildBackgroundServiceHealthFindings(params: Readonly<{
  daemonStatus: ServiceRepairDaemonStatusSnapshot | null | undefined;
  backgroundServiceHealth: BackgroundServiceHealthSummary | null | undefined;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentReleaseChannel: string;
}>): ServiceRepairFinding[] {
  const entry = params.automaticStartup.find((candidate) =>
    isCurrentChannelStartupEntry(candidate, params.currentReleaseChannel))
    ?? firstDefaultFollowingEntry(params.automaticStartup);
  if (params.backgroundServiceHealth?.status === 'crash_looping') {
    return [{
      id: `background-service:crash-looping:${entry ? startupEntryKey(entry) : 'current'}`,
      kind: 'background_service_crash_looping',
      severity: 'error',
      title: 'Background service appears to be crash-looping.',
      diagnostic: formatHealthDiagnostic(params.backgroundServiceHealth),
      warningCode: null,
      entry,
      targetMode: entry?.targetMode ?? null,
      recoveryStrategy: 'manual',
      actions: [],
    }];
  }

  const installed = params.daemonStatus?.service?.installed === true || entry?.running === false;
  const running = params.daemonStatus?.daemon.running === true
    || params.daemonStatus?.service?.running === true
    || entry?.running === true;
  if (!installed || running) {
    return [];
  }
  return [{
    id: `background-service:not-running:${entry ? startupEntryKey(entry) : 'current'}`,
    kind: 'background_service_not_running',
    severity: 'warning',
    title: 'Background service is installed but not running.',
    diagnostic: entry?.definitionPath ?? null,
    warningCode: null,
    entry,
    targetMode: entry?.targetMode ?? null,
    recoveryStrategy: 'service-restart',
    actions: [{
      kind: 'run-command',
      command: 'happier service start',
    }],
  }];
}

function dedupeRunningDaemonEntries(entries: readonly RunningDaemonEntry[]): RunningDaemonEntry[] {
  const byKey = new Map<string, RunningDaemonEntry>();
  for (const entry of entries) {
    const key = [
      entry.profileId ?? '',
      entry.label ?? '',
      entry.managedByEntryId ?? '',
      entry.version ?? '',
    ].join(':');
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function buildRunningDaemonDuplicateFindings(entries: readonly RunningDaemonEntry[]): ServiceRepairFinding[] {
  const byProfile = new Map<string, RunningDaemonEntry[]>();
  for (const entry of entries) {
    const profileId = normalizeText(entry.profileId);
    if (!profileId) {
      continue;
    }
    byProfile.set(profileId, [...(byProfile.get(profileId) ?? []), entry]);
  }
  return [...byProfile.entries()]
    .filter(([, profileEntries]) => profileEntries.length > 1)
    .map(([profileId, profileEntries]) => ({
      id: `running-daemon:duplicate-profile:${profileId}`,
      kind: 'running_daemon_duplicate_profile' as const,
      severity: 'warning' as const,
      title: `Multiple running background services target Relay profile ${profileId}.`,
      diagnostic: profileEntries.map((entry) => entry.label ?? entry.version ?? 'unknown').join(', '),
      warningCode: null,
      entry: null,
      targetMode: null,
      recoveryStrategy: 'daemon-stop' as const,
      actions: [{
        kind: 'run-command' as const,
        command: 'happier daemon stop',
      }],
    }));
}

function isLocalRelayInstalled(relay: LocalRelayEntry): boolean {
  return relay.installed === true || (relay.installed !== false && (relay.active || relay.url !== null));
}

function isLocalRelayVersionStale(relay: LocalRelayEntry): boolean {
  if (relay.versionStale === true) {
    return true;
  }
  const version = normalizeText(relay.version);
  const expectedVersion = normalizeText(relay.expectedVersion);
  return version !== null && expectedVersion !== null && version !== expectedVersion;
}

function buildLocalRelayFindings(params: Readonly<{
  localRelays: readonly LocalRelayEntry[];
  currentReleaseChannel: string;
}>): ServiceRepairFinding[] {
  const currentReleaseChannelLabel = formatReleaseChannelLabel(params.currentReleaseChannel);
  const currentChannelLocalRelay = params.localRelays.find((relay) =>
    releaseChannelsMatch(relay.releaseChannel, params.currentReleaseChannel));
  const leftovers = params.localRelays.filter((relay) => {
    const releaseChannel = normalizeReleaseChannelForComparison(relay.releaseChannel);
    return releaseChannel && !releaseChannelsMatch(releaseChannel, params.currentReleaseChannel) && isLocalRelayInstalled(relay);
  });
  const findings: ServiceRepairFinding[] = [];
  if (!currentChannelLocalRelay || !isLocalRelayInstalled(currentChannelLocalRelay)) {
    if (leftovers.length > 0) {
      findings.push({
        id: 'local-relay:lane-missing',
        kind: 'local_relay_lane_missing',
        severity: 'warning',
        title: `No local Relay is installed on ${currentReleaseChannelLabel}.`,
        diagnostic: `Other installed local Relays: ${leftovers.map((relay) => `${formatReleaseChannelLabel(relay.releaseChannel)}:${relay.url ?? relay.id}`).join(', ')}`,
        warningCode: null,
        entry: null,
        targetMode: null,
        actions: [],
      });
    }
    return findings;
  }
  if (isLocalRelayVersionStale(currentChannelLocalRelay)) {
    findings.push({
      id: 'local-relay:version-stale',
      kind: 'local_relay_version_stale',
      severity: 'warning',
      title: `Local Relay on ${currentReleaseChannelLabel} is stale.`,
      diagnostic: [
        normalizeText(currentChannelLocalRelay.version) ? `installed=${currentChannelLocalRelay.version}` : null,
        normalizeText(currentChannelLocalRelay.expectedVersion) ? `expected=${currentChannelLocalRelay.expectedVersion}` : null,
        normalizeText(currentChannelLocalRelay.diagnostic),
      ].filter((line): line is string => line !== null).join(', ') || null,
      warningCode: null,
      entry: null,
      targetMode: null,
      actions: [],
    });
  }
  if (leftovers.length > 0) {
    findings.push({
      id: 'local-relay:off-channel-leftovers',
      kind: 'local_relay_off_channel_leftovers',
      severity: 'info',
      title: 'Other release channels have local Relay leftovers.',
      diagnostic: leftovers.map((relay) => relay.url ?? relay.id).join(', '),
      warningCode: null,
      entry: null,
      targetMode: null,
      actions: [],
    });
  }
  return findings;
}

function buildOtherChannelDaemonFindings(params: Readonly<{
  automaticStartup: readonly AutomaticStartupEntry[];
  currentReleaseChannel: string;
}>): ServiceRepairFinding[] {
  return params.automaticStartup
    .filter((entry) =>
      entry.running === true
      && String(entry.releaseChannel ?? '').trim().length > 0
      && !releaseChannelsMatch(entry.releaseChannel, params.currentReleaseChannel))
    .map((entry) => ({
      id: `other-channel-daemon:${startupEntryKey(entry)}`,
      kind: 'orphan_daemon_on_other_channel' as const,
      severity: 'info' as const,
      title: `Background service is running on ${formatReleaseChannelLabel(entry.releaseChannel)}.`,
      diagnostic: entry.definitionPath,
      warningCode: null,
      entry,
      targetMode: entry.targetMode,
      actions: [],
    }));
}

function dedupeFindings(findings: readonly ServiceRepairFinding[]): ServiceRepairFinding[] {
  const byKey = new Map<string, ServiceRepairFinding>();
  const daemonMismatchEntries = findings
    .filter((finding) => finding.kind === 'running_daemon_cli_mismatch' && finding.entry !== null)
    .map((finding) => finding.entry);
  for (const finding of findings) {
    if (
      finding.kind === 'automatic_startup_version_stale'
      && daemonMismatchEntries.some((entry) => isSameManagedSlot(finding.entry, entry))
    ) {
      continue;
    }
    const key = [
      finding.kind,
      finding.warningCode ?? '',
      finding.entry ? startupEntryKey(finding.entry) : finding.id,
      finding.targetMode ?? '',
    ].join(':');
    const existing = byKey.get(key);
    if (!existing || (existing.warningCode === null && finding.warningCode !== null)) {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()];
}

export function buildServiceRepairReport(params: BuildServiceRepairReportParams): ServiceRepairReport {
  const automaticStartup = dedupeStartupEntries([
    ...params.plan.existingServices.map(normalizeStartupEntry).filter((entry): entry is AutomaticStartupEntry => entry !== null),
    ...(params.discoveredServices ?? []).map(normalizeDiscoveredService).filter((entry): entry is AutomaticStartupEntry => entry !== null),
  ]);
  const currentReleaseChannel = String(params.runtime.channel ?? '').trim();
  const currentlyRunning = buildCurrentlyRunningDaemonEntries({
      daemonStatus: params.daemonStatus,
      automaticStartup,
    });
  const allRunningDaemons = dedupeRunningDaemonEntries([
    ...currentlyRunning,
    ...(params.runningDaemons ?? []),
  ]);
  const findings = dedupeFindings([
    ...buildStackFindings({
      stacks: params.stacks,
      currentReleaseChannel,
      publicServerUrl: normalizeText(params.runtime.publicServerUrl),
    }),
    ...buildAuthFindings(params.authProfiles),
    ...buildBackgroundServiceHealthFindings({
      daemonStatus: params.daemonStatus,
      backgroundServiceHealth: params.backgroundServiceHealth,
      automaticStartup,
      currentReleaseChannel,
    }),
    ...buildRunningDaemonDuplicateFindings(allRunningDaemons),
    ...buildWarningFindings({
      warnings: params.warnings ?? [],
      automaticStartup,
      currentReleaseChannel,
      daemonStatus: params.daemonStatus,
    }),
    ...buildLocalRelayFindings({
      localRelays: params.localRelays ?? [],
      currentReleaseChannel,
    }),
    ...buildOtherChannelDaemonFindings({
      automaticStartup,
      currentReleaseChannel,
    }),
    ...buildActionFindings({
      actions: params.plan.actions,
      automaticStartup,
      currentReleaseChannel,
    }),
  ]);

  return {
    currentCli: {
      releaseChannel: params.runtime.channel,
      happierHomeDir: normalizeText(params.runtime.happierHomeDir),
      serverUrl: normalizeText(params.runtime.serverUrl),
      publicServerUrl: normalizeText(params.runtime.publicServerUrl),
    },
    daemonStatus: params.daemonStatus ?? null,
    automaticStartup,
    currentlyRunning: allRunningDaemons,
    localRelays: [...(params.localRelays ?? [])],
    authProfiles: [...(params.authProfiles ?? [])],
    stacks: [...(params.stacks ?? [])],
    findings,
    manualWarnings: [...params.plan.manualWarnings],
  };
}

export function defaultFollowingMatchesSelectedReleaseChannel(report: ServiceRepairReport): boolean {
  const currentReleaseChannel = String(report.currentCli.releaseChannel ?? '').trim();
  return report.automaticStartup.some((entry) =>
    entry.targetMode === 'default-following'
    && releaseChannelsMatch(entry.releaseChannel, currentReleaseChannel));
}
