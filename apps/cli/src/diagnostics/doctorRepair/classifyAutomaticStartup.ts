import {
  getReleaseRingCatalogEntry,
  getReleaseRingPublicLabel,
  type PublicReleaseRingId,
  type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import type { DaemonServiceMode } from '@/daemon/service/plan';

import type {
  AutomaticStartupDuplicateDefaultFollowing,
  AutomaticStartupDuplicatePinnedSameServer,
  AutomaticStartupEntry,
  AutomaticStartupForeignHome,
  AutomaticStartupLaneMismatch,
  AutomaticStartupLegacyChannelScoped,
  AutomaticStartupLegacyPinnedCurrentServer,
  AutomaticStartupMissing,
  AutomaticStartupStaleDefinition,
  AutomaticStartupVersionStale,
  RepairFinding,
} from './types';

/**
 * Derive user-visible findings from the existing, battle-tested
 * `BackgroundServiceRepairPlan`. This is a *projection*, not a re-implementation.
 *
 * Auto-apply policy (matches plan §4.3):
 *   version_stale      → true
 *   stale_definition   → true
 *   legacy_channel_scoped → true
 *   missing on stable  → true
 *   missing on preview/dev → false
 *   lane_mismatch      → false
 *   legacy_pinned_current_server → false
 *   duplicate_default_following → true (cleanup is safe)
 *   duplicate_pinned_same_server → true
 *   foreign_home       → false (never automatable)
 *
 * `onMigration=true` (installer 0.2.3 hook) broadens lane_mismatch and
 * legacy_pinned_current_server to auto-apply as well.
 */
export function classifyAutomaticStartup(params: Readonly<{
  plan: BackgroundServiceRepairPlan;
  entries: readonly AutomaticStartupEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliRingId: PublicReleaseRingId;
  currentCliVersion: string;
  currentServerId: string;
  preferredMode: DaemonServiceMode;
  onMigration?: boolean;
}>): readonly RepairFinding[] {
  const findings: RepairFinding[] = [];

  // Foreign-home: block all automatable work (matches planner early-return)
  if (params.plan.manualWarnings.length > 0) {
    const foreignEntries = params.entries.filter((e) => e.isForeignHome);
    const foreign: AutomaticStartupForeignHome = {
      kind: 'automatic_startup_foreign_home',
      severity: 'warning',
      autoApplyWithoutPrompt: false,
      entries: foreignEntries,
      messages: params.plan.manualWarnings,
    };
    findings.push(foreign);
    return findings;
  }

  const removeActions = params.plan.actions.flatMap((a) =>
    a.kind === 'remove-service' ? [a] : [],
  );
  const installActions = params.plan.actions.flatMap((a) =>
    a.kind === 'install-default-following-service' ? [a] : [],
  );
  const hasCompatibleDefaultFollowing = params.entries.some((e) =>
    e.targetMode === 'default-following'
    && e.ringId === params.currentCliRingId
    && !e.isForeignHome,
  );

  // Find the entry that matches a remove action so we can attach it to findings.
  const matchRemoveEntry = (installedPath: string): AutomaticStartupEntry | null => {
    return params.entries.find((e) => e.path === installedPath) ?? null;
  };

  // Duplicate default-following under same home
  const duplicateDefaultFollowingRemoves = removeActions.filter((a) => {
    if (a.service.targetMode !== 'default-following') return false;
    const entry = matchRemoveEntry(a.service.installedPath);
    if (!entry) return false;
    return !entry.isForeignHome;
  });

  // Duplicate pinned same-server
  const duplicatePinnedSameServerRemoves = removeActions.filter((a) => {
    if (a.service.targetMode !== 'pinned') return false;
    return a.service.instanceId === params.currentServerId;
  });

  // Legacy-pinned current server: pinned removals whose target is current server
  if (duplicatePinnedSameServerRemoves.length > 0 && installActions.length > 0) {
    const entry = matchRemoveEntry(duplicatePinnedSameServerRemoves[0].service.installedPath);
    if (entry) {
      const legacyPinned: AutomaticStartupLegacyPinnedCurrentServer = {
        kind: 'automatic_startup_legacy_pinned_current_server',
        severity: 'info',
        autoApplyWithoutPrompt: params.onMigration === true,
        entry,
      };
      findings.push(legacyPinned);
    }
  } else if (duplicatePinnedSameServerRemoves.length > 1) {
    const entries = duplicatePinnedSameServerRemoves
      .map((a) => matchRemoveEntry(a.service.installedPath))
      .filter((e): e is AutomaticStartupEntry => e !== null);
    if (entries.length > 0) {
      const dupPinned: AutomaticStartupDuplicatePinnedSameServer = {
        kind: 'automatic_startup_duplicate_pinned_same_server',
        severity: 'warning',
        autoApplyWithoutPrompt: true,
        serverId: params.currentServerId,
        keeper: entries[0],
        duplicates: entries.slice(1),
      };
      findings.push(dupPinned);
    }
  }

  // Legacy channel-scoped: default-following removals whose entry is legacy-scoped
  const legacyScopedRemoves = duplicateDefaultFollowingRemoves.filter((a) => {
    const entry = matchRemoveEntry(a.service.installedPath);
    return entry?.isLegacyChannelScoped === true;
  });
  if (legacyScopedRemoves.length > 0 && installActions.length > 0) {
    const entry = matchRemoveEntry(legacyScopedRemoves[0].service.installedPath);
    if (entry) {
      const legacyScoped: AutomaticStartupLegacyChannelScoped = {
        kind: 'automatic_startup_legacy_channel_scoped',
        severity: 'info',
        autoApplyWithoutPrompt: true,
        entry,
      };
      findings.push(legacyScoped);
    }
  }

  // Lane mismatch: a default-following service exists, but not for the current lane.
  const laneMismatchEntries = params.entries.filter((e) =>
    e.targetMode === 'default-following'
    && e.ringId !== params.currentCliRingId
    && !e.isForeignHome,
  );
  if (laneMismatchEntries.length > 0 && !hasCompatibleDefaultFollowing) {
    const laneMismatch: AutomaticStartupLaneMismatch = {
      kind: 'automatic_startup_lane_mismatch',
      severity: 'warning',
      autoApplyWithoutPrompt: params.onMigration === true,
      existing: laneMismatchEntries,
      targetReleaseChannel: params.currentCliReleaseChannel,
    };
    findings.push(laneMismatch);
  }

  // Duplicate default-following
  const sameLaneRemoves = duplicateDefaultFollowingRemoves.filter((a) => {
    const entry = matchRemoveEntry(a.service.installedPath);
    if (!entry) return false;
    return entry.ringId === params.currentCliRingId && !entry.isLegacyChannelScoped;
  });
  if (sameLaneRemoves.length >= 2) {
    const entries = sameLaneRemoves
      .map((a) => matchRemoveEntry(a.service.installedPath))
      .filter((e): e is AutomaticStartupEntry => e !== null);
    const dupDefault: AutomaticStartupDuplicateDefaultFollowing = {
      kind: 'automatic_startup_duplicate_default_following',
      severity: 'warning',
      autoApplyWithoutPrompt: true,
      keeper: entries[0],
      duplicates: entries.slice(1),
    };
    findings.push(dupDefault);
  }

  // Stale definition: a same-lane default-following entry whose definition differs
  const staleEntry = params.entries.find((e) =>
    e.targetMode === 'default-following'
    && e.ringId === params.currentCliRingId
    && !e.isForeignHome
    && e.installedDefinitionMatchesExpected === false
    && !e.isLegacyChannelScoped,
  );
  if (staleEntry) {
    const stale: AutomaticStartupStaleDefinition = {
      kind: 'automatic_startup_stale_definition',
      severity: 'warning',
      autoApplyWithoutPrompt: true,
      entry: staleEntry,
    };
    findings.push(stale);
  }

  // Missing: no compatible default-following + an install action queued
  if (!hasCompatibleDefaultFollowing && installActions.length > 0 && findings.length === 0) {
    const missing: AutomaticStartupMissing = {
      kind: 'automatic_startup_missing',
      severity: 'info',
      autoApplyWithoutPrompt: params.currentCliReleaseChannel === 'stable'
        || params.onMigration === true,
      targetReleaseChannel: params.currentCliReleaseChannel,
      preferredMode: params.preferredMode,
    };
    findings.push(missing);
  }

  // Version stale: a matching default-following entry whose runningCliVersion is behind current
  const runningEntry = params.entries.find((e) =>
    e.targetMode === 'default-following'
    && e.ringId === params.currentCliRingId
    && e.running === true
    && e.runningCliVersion !== null
    && e.runningCliVersion !== params.currentCliVersion,
  );
  if (runningEntry && runningEntry.runningCliVersion !== null) {
    const versionStale: AutomaticStartupVersionStale = {
      kind: 'automatic_startup_version_stale',
      severity: 'info',
      autoApplyWithoutPrompt: true,
      entry: runningEntry,
      currentCliVersion: params.currentCliVersion,
    };
    findings.push(versionStale);
  }

  return findings;
}

// Intentionally exported alongside to share release-runtime re-wrap helpers with
// other classifiers.
export function ringIdToPublicLabel(ring: PublicReleaseRingId): PublicReleaseRingLabel {
  return getReleaseRingPublicLabel(ring);
}

export function publicLabelToRingId(label: PublicReleaseRingLabel): PublicReleaseRingId {
  if (label === 'stable') return 'stable';
  if (label === 'preview') return 'preview';
  return 'publicdev';
}

// Re-export so consumers don't have to pull from two places
export { getReleaseRingCatalogEntry };
