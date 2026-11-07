import type {
  PluginChangePendingReviewResult,
  PluginInstallationReview,
} from '@happier-dev/protocol/marketplace/internal';
import { presentMachineAuthorityV1, type MachineAuthorityPresentationV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';

export type PluginInstallPendingReview = Extract<
  PluginChangePendingReviewResult,
  Readonly<{ kind: 'reviewRequired'; reviewKind: 'installation' }>
>;

/** The daemon's own scope categories: what a first install uses, or what an update newly asks for. */
export type PluginInstallConsentScope = PluginInstallPendingReview['authorityExpansion'][number];

export type PluginInstallConsentUse = Readonly<{
  scope: PluginInstallConsentScope;
  /** A declared name (capability, origin, credential slot); never copy the view must translate. */
  label: string;
}>;

/**
 * The install consent a person confirms (Chrome-extension model, owner ruling 2026-10-29): a first
 * install names the plugin, its publisher and everything it uses; an update that asks for new scope
 * names only what is new. Plugins are trusted code, so this informs the person; it is not a fence.
 */
export type PluginInstallConsentFacts = Readonly<{
  kind: 'firstInstall' | 'newScope';
  pluginId: string;
  pluginName: string;
  version: string;
  /** The installed version an update replaces; `null` for a first install. */
  currentVersion: string | null;
  /** Publisher labels are unverified catalog metadata; `null` when unavailable. */
  publisher: Readonly<{ id: string; displayName: string }> | null;
  uses: readonly PluginInstallConsentUse[];
}>;

/** A retained review has no live inspect transport/identity provenance, even after reconnect. */
export function presentPluginInstallationReviewAuthority(review: PluginInstallationReview): MachineAuthorityPresentationV1 {
  return presentMachineAuthorityV1({ observation: review.daemonRights?.observation, freshness: 'stale' });
}

/** Declared ids read as words ("connectedAccounts" → "Connected accounts"). */
function humanizeDeclaredWord(word: string): string {
  const words = word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : word;
}

function listUses(review: PluginInstallationReview, expansion: readonly PluginInstallConsentScope[]): readonly PluginInstallConsentUse[] {
  const uses: PluginInstallConsentUse[] = [
    ...review.requiredHostAccess.map((entry): PluginInstallConsentUse => ({
      scope: entry.capability === 'connectedAccounts' ? 'connectedAccountPurpose' : 'requiredHostAccess',
      label: humanizeDeclaredWord(entry.capability),
    })),
    // Agent purposes are compared by the daemon separately from hostAccess. Its
    // expansion fact names the category even when the review has no access row.
    ...(expansion.includes('connectedAccountPurpose') ? [{
      scope: 'connectedAccountPurpose' as const,
      label: humanizeDeclaredWord('connectedAccounts'),
    }] : []),
    ...review.optionalHostAccess.map((entry): PluginInstallConsentUse => ({
      scope: 'selectedOptionalHostAccess',
      label: humanizeDeclaredWord(entry.capability),
    })),
    ...review.requestInterceptors.map((entry): PluginInstallConsentUse => ({
      scope: 'requestInterceptor',
      label: entry.origins.join(', '),
    })),
    ...review.rawCredentialAccess.map((entry): PluginInstallConsentUse => ({
      scope: 'rawCredentialAccess',
      label: entry.credentialSlot.title,
    })),
  ];
  const seen = new Set<string>();
  return uses.filter((use) => {
    const key = `${use.scope}\0${use.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function describePluginInstallConsent(pendingReview: PluginInstallPendingReview): PluginInstallConsentFacts {
  const { review } = pendingReview;
  const newScope = pendingReview.reason === 'authorityExpansion';
  const expansion = new Set<PluginInstallConsentScope>(pendingReview.authorityExpansion);
  const uses = listUses(review, pendingReview.authorityExpansion);
  return {
    kind: newScope ? 'newScope' : 'firstInstall',
    pluginId: review.pluginId,
    pluginName: review.displayName,
    version: review.version,
    currentVersion: newScope ? pendingReview.currentVersion : null,
    publisher: review.publisherIdentity.status === 'unavailable'
      ? null
      : { id: review.publisherIdentity.id, displayName: review.publisherIdentity.displayName },
    uses: newScope ? uses.filter((use) => expansion.has(use.scope)) : uses,
  };
}
