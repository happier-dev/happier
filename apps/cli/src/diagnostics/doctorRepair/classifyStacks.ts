import type { PublicReleaseRingId, PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import type {
  AutomaticStartupEntry,
  ChannelSwitchRecommended,
  DevOnHostedCloudInformational,
  LocalRelayEntry,
  MultiStackDetectedInformational,
  NoActiveStackYet,
  RepairFinding,
  RunningDaemonEntry,
  StackArchetype,
  StackEntry,
} from './types';

const HOSTED_CLOUD_HOSTNAMES: readonly string[] = ['happier.dev', 'api.happier.dev'];

function isHostedCloudUrl(url: string | null | undefined): boolean {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return HOSTED_CLOUD_HOSTNAMES.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function isLoopbackUrl(url: string | null | undefined): boolean {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

function labelFromChannelLike(value: unknown): PublicReleaseRingLabel | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'stable' || raw === 'preview' || raw === 'dev') return raw;
  if (raw === 'publicdev') return 'dev';
  return null;
}

function ringIdForLabel(label: PublicReleaseRingLabel): PublicReleaseRingId {
  if (label === 'preview') return 'preview';
  if (label === 'dev') return 'publicdev';
  return 'stable';
}

function pickArchetype(params: Readonly<{
  hasDaemon: boolean;
  localRelay: LocalRelayEntry | null;
  isHostedCloud: boolean;
  activeServerUrl: string | null;
}>): StackArchetype {
  if (!params.hasDaemon) return 'cli-only';
  if (params.localRelay) return 'cli-daemon-local-relay';
  if (params.isHostedCloud) return 'cli-daemon-hosted';
  if (params.activeServerUrl) return 'cli-daemon-self-hosted';
  return 'unknown';
}

/**
 * Group components (automatic-startup services, running daemons, local relays)
 * by release channel into coherent `StackEntry`s. Each stack is a {daemon,
 * relay, service} triple that all share the same channel. Missing components
 * in a stack are just "that piece isn't installed yet" — not drift.
 *
 * A side-by-side dev+preview setup with matching components per channel is
 * two stacks. A user with only a preview daemon (no matching relay) is one
 * partial stack on the preview channel.
 */
function buildStacks(params: Readonly<{
  automaticStartup: readonly AutomaticStartupEntry[];
  currentlyRunning: readonly RunningDaemonEntry[];
  localRelays: readonly LocalRelayEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  activeServerUrl: string | null;
}>): readonly StackEntry[] {
  const byChannel = new Map<PublicReleaseRingLabel, {
    daemon: RunningDaemonEntry | null;
    relay: LocalRelayEntry | null;
    service: AutomaticStartupEntry | null;
  }>();
  const seenChannel = (c: PublicReleaseRingLabel) => {
    if (!byChannel.has(c)) byChannel.set(c, { daemon: null, relay: null, service: null });
    return byChannel.get(c)!;
  };
  for (const d of params.currentlyRunning) {
    const channel = d.startedWithReleaseChannel;
    if (!channel) continue;
    seenChannel(channel).daemon ??= d;
  }
  for (const r of params.localRelays) {
    seenChannel(r.releaseChannel).relay ??= r;
  }
  for (const s of params.automaticStartup) {
    // Foreign-home services are not OUR stack — skip.
    if (s.isForeignHome) continue;
    seenChannel(s.releaseChannel).service ??= s;
  }

  const hostedCloudActive = isHostedCloudUrl(params.activeServerUrl);
  return Array.from(byChannel.entries()).map(([channel, pieces]): StackEntry => ({
    releaseChannel: channel,
    ringId: ringIdForLabel(channel),
    hasCurrentCli: channel === params.currentCliReleaseChannel,
    archetype: pickArchetype({
      hasDaemon: pieces.daemon !== null,
      localRelay: pieces.relay,
      isHostedCloud: hostedCloudActive,
      activeServerUrl: params.activeServerUrl,
    }),
    runningDaemon: pieces.daemon,
    localRelay: pieces.relay,
    automaticStartup: pieces.service,
    // Active-server URL is stored on the stack for the one the current CLI
    // would talk to — i.e. only make sense for the `hasCurrentCli` stack.
    activeServerUrl: channel === params.currentCliReleaseChannel ? params.activeServerUrl : null,
    isHostedCloudActive: channel === params.currentCliReleaseChannel && hostedCloudActive,
  }));
}

/**
 * Pick the stack that's "currently active" on this machine — the one the user
 * would be interacting with if they opened a terminal right now and ran
 * `happier`. Preference order: running daemon > configured service > local relay.
 */
function pickActiveStack(
  stacks: readonly StackEntry[],
  currentCliChannel: PublicReleaseRingLabel,
): StackEntry | null {
  const running = stacks.filter((s) => s.runningDaemon !== null);
  if (running.length === 1) return running[0];
  if (running.length > 1) {
    // Multi-stack running — prefer the one matching the current CLI; otherwise
    // the first by order.
    const match = running.find((s) => s.releaseChannel === currentCliChannel);
    return match ?? running[0];
  }
  const withService = stacks.filter((s) => s.automaticStartup !== null);
  if (withService.length > 0) {
    return withService.find((s) => s.releaseChannel === currentCliChannel) ?? withService[0];
  }
  return stacks[0] ?? null;
}

export function classifyStacks(params: Readonly<{
  automaticStartup: readonly AutomaticStartupEntry[];
  currentlyRunning: readonly RunningDaemonEntry[];
  localRelays: readonly LocalRelayEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  activeServerUrl: string | null;
  onMigration?: boolean;
}>): Readonly<{ stacks: readonly StackEntry[]; findings: readonly RepairFinding[] }> {
  const stacks = buildStacks(params);
  const findings: RepairFinding[] = [];

  const activeStack = pickActiveStack(stacks, params.currentCliReleaseChannel);

  // Case 1: No stack on the current CLI's channel at all.
  // Either the user has no stacks anywhere (fresh install) OR they have a
  // stack on a different channel (channel-switch moment).
  const onCurrentChannel = stacks.find((s) => s.releaseChannel === params.currentCliReleaseChannel);
  if (!onCurrentChannel) {
    if (activeStack && activeStack.releaseChannel !== params.currentCliReleaseChannel) {
      // Channel-switch moment — user has an active stack on a DIFFERENT channel.
      const willActiveServerChange = activeStack.runningDaemon !== null;
      const targetChannelHasLocalRelay = params.localRelays.some(
        (r) => r.releaseChannel === params.currentCliReleaseChannel,
      );
      const finding: ChannelSwitchRecommended = {
        kind: 'channel_switch_recommended',
        severity: 'info',
        // The 0.2.3 installer-migration hook broadens auto-apply so a
        // `happier self update` across the boundary can converge stacks
        // non-interactively. In normal interactive use this stays false so
        // channel switches are always explicit.
        autoApplyWithoutPrompt: params.onMigration === true,
        fromStack: activeStack,
        toChannel: params.currentCliReleaseChannel,
        willActiveServerChange,
        targetChannelHasLocalRelay,
      };
      findings.push(finding);
    } else {
      // Fresh install — no stack anywhere.
      const finding: NoActiveStackYet = {
        kind: 'no_active_stack_yet',
        severity: 'info',
        autoApplyWithoutPrompt: false,
        releaseChannel: params.currentCliReleaseChannel,
      };
      findings.push(finding);
    }
  }

  // Case 2: Multiple stacks running simultaneously — informational only.
  const runningStacks = stacks.filter((s) => s.runningDaemon !== null);
  if (runningStacks.length > 1) {
    const informational: MultiStackDetectedInformational = {
      kind: 'multi_stack_detected_informational',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      stacks: runningStacks,
    };
    findings.push(informational);
  }

  // Case 3: dev CLI active on hosted cloud without a local dev relay — soft advice.
  const currentStack = stacks.find((s) => s.releaseChannel === params.currentCliReleaseChannel);
  if (
    params.currentCliReleaseChannel === 'dev'
    && currentStack?.isHostedCloudActive === true
    && !params.localRelays.some((r) => r.releaseChannel === 'dev')
  ) {
    const finding: DevOnHostedCloudInformational = {
      kind: 'dev_on_hosted_cloud_informational',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      activeServerUrl: currentStack.activeServerUrl ?? '',
    };
    findings.push(finding);
  }

  return { stacks, findings };
}

export { isHostedCloudUrl, isLoopbackUrl, labelFromChannelLike };
