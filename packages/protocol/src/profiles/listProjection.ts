import {
  getRequiredConfigEnvVarNames,
  getRequiredSecretEnvVarNames,
} from './profileRequirements.js';
import { isProfileCompatibleWithAgent } from './profileCompatibility.js';
import { isLaunchProfileV2, type AiLaunchProfile } from './read.js';
import type { AIBackendProfile } from './backendProfileSchema.js';
import type {
  LaunchProfileCheckoutPreferenceV1,
  LaunchProfilePlacementPreferenceV1,
} from './v2/schema.js';

/**
 * The one projection of a Launch Profile onto the inventory row every launch
 * surface reads — `sessions.spawn.profiles.list`.
 *
 * It lives beside the profile schema rather than in one host because two hosts
 * answer that Action: the CLI reads the Account settings it fetched, and the
 * app reads the Account settings it already holds. A row shaped differently by
 * whichever host happened to answer would make a caller's profile resolution
 * depend on where it ran, which is the split-brain this extraction removes.
 *
 * `agentIds` is a parameter because the agent catalog is a host package the
 * Protocol does not depend on. Compatibility itself is still decided here, so
 * the rule has one owner and only its input is supplied.
 */
export type LaunchProfileListItemV1 = Readonly<{
  id: string;
  name: string;
  isBuiltIn: boolean;
  description?: string;
  supportedAgentIds: string[];
  requiredSecretEnvVarNames: string[];
  requiredConfigEnvVarNames: string[];
  authMode?: AIBackendProfile['authMode'];
  requiresMachineLoginTargetKey?: string;
  requiresMachineLogin?: string;
  /**
   * The three Session defaults a launching caller resolves the profile FOR.
   *
   * They are carried on the inventory row because a caller that has already
   * asked "which profiles exist" must not then need a second, differently
   * shaped read to learn what the one it picked prefers. All three are
   * preferences and none is a stored resolution: `placement` names a machine
   * only in its `fixed` arm, and `checkout` names what to DO, never a
   * materialized checkout's kind.
   */
  preferredAgentTargetKey?: string;
  placement?: LaunchProfilePlacementPreferenceV1;
  checkout?: LaunchProfileCheckoutPreferenceV1;
}>;

export function mapAiLaunchProfileToListItemV1(
  profile: AiLaunchProfile,
  params: Readonly<{ agentIds: readonly string[] }>,
): LaunchProfileListItemV1 {
  const slim = isLaunchProfileV2(profile);
  return {
    id: profile.id,
    name: profile.name,
    isBuiltIn: slim ? false : profile.isBuiltIn === true,
    ...(profile.description ? { description: profile.description } : {}),
    supportedAgentIds: params.agentIds.filter((agentId) => (slim
      ? profile.compatibilityByTargetKey[`agent:${agentId}`] !== false
        && (Object.keys(profile.compatibilityByTargetKey).length === 0
          || profile.compatibilityByTargetKey[`agent:${agentId}`] === true)
      : isProfileCompatibleWithAgent(profile, agentId))),
    requiredSecretEnvVarNames: slim ? [] : getRequiredSecretEnvVarNames(profile),
    requiredConfigEnvVarNames: slim ? [] : getRequiredConfigEnvVarNames(profile),
    ...(!slim && profile.authMode ? { authMode: profile.authMode } : {}),
    ...(!slim && profile.requiresMachineLoginTargetKey
      ? { requiresMachineLoginTargetKey: profile.requiresMachineLoginTargetKey }
      : {}),
    ...(!slim && profile.requiresMachineLogin
      ? { requiresMachineLogin: profile.requiresMachineLogin }
      : {}),
    ...(slim && profile.preferredAgentTargetKey !== undefined
      ? { preferredAgentTargetKey: profile.preferredAgentTargetKey }
      : {}),
    ...(slim && profile.placement !== undefined ? { placement: profile.placement } : {}),
    ...(slim && profile.checkout !== undefined ? { checkout: profile.checkout } : {}),
  };
}

/**
 * The whole answer to `sessions.spawn.profiles.list`, not just one row.
 *
 * The row projection was shared and the list around it was not, so each host
 * repeated the same filter, the same sort and the same slice — and both sliced
 * SILENTLY. A caller resolving one stored id against a truncated answer could
 * not tell "your account no longer holds this profile" from "your account holds
 * it, just not in the part I was sent", and reported the first: a false,
 * non-retryable verdict for a profile that exists.
 *
 * So the result carries its own completeness. `totalCount` is what the filter
 * matched and `truncated` says whether the caller is looking at all of it.
 */
export type LaunchProfileListProjectionV1 = Readonly<{
  agentId?: string;
  items: readonly (LaunchProfileListItemV1 & Readonly<{ value: string; label: string }>)[];
  /** How many profiles matched, whether or not they all fit in `items`. */
  totalCount: number;
  /** True only when `items` is a prefix of the matches, never as a warning. */
  truncated: boolean;
  /**
   * What an absent row means in this answer.
   *
   * `unreadable` means retained Account rows were written in a schema this
   * host cannot execute. `unavailable` means the host has not hydrated the
   * Account settings it would read. Neither may be interpreted as deletion.
   */
  coverage: 'complete' | 'truncated' | 'unreadable' | 'unavailable';
}>;

/**
 * `limit` is the CALLER's bound and nothing else applies one.
 *
 * There is no default ceiling here, because there is no resource a default
 * would protect: these rows project Account settings this host already holds
 * whole, so listing them cannot exceed a transport the same data has already
 * crossed. A picked default cap would only reintroduce the silent truncation
 * this projection exists to make visible.
 */
export function projectLaunchProfileListV1(
  profiles: readonly AiLaunchProfile[],
  params: Readonly<{
    agentIds: readonly string[];
    agentId?: string;
    limit?: unknown;
    unreadableCount?: number;
    available?: boolean;
  }>,
): LaunchProfileListProjectionV1 {
  const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
  const matched = profiles
    .map((profile) => mapAiLaunchProfileToListItemV1(profile, { agentIds: params.agentIds }))
    .filter((profile) => agentId.length === 0 || profile.supportedAgentIds.includes(agentId))
    .map((profile) => ({ ...profile, value: profile.id, label: profile.name }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
    ? Math.floor(params.limit)
    : null;
  const truncated = limit !== null && matched.length > limit;
  const coverage = params.available === false
    ? 'unavailable'
    : (params.unreadableCount ?? 0) > 0
      ? 'unreadable'
      : truncated
        ? 'truncated'
        : 'complete';
  return {
    ...(agentId.length > 0 ? { agentId } : {}),
    items: truncated ? matched.slice(0, limit as number) : matched,
    totalCount: matched.length,
    truncated,
    coverage,
  };
}
