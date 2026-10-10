import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The one plugin update policy, for every surface that declares, transports,
 * reviews, or persists it: a marketplace listing, the installation review a
 * human decides on, the daemon change contract, and the installed trust
 * record.
 *
 * `allowed` admits an explicit update request and `pinned` freezes the current
 * release. Whether a candidate needs a present-user decision is owned by the
 * canonical authority-delta classifier, never by this eligibility setting.
 * There are no aliases and no surface-local variants.
 */
export const PluginUpdatePolicyV1Schema = lazyZodSchema(() => z.enum([
  'allowed',
  'pinned',
]));
export type PluginUpdatePolicyV1 = z.infer<typeof PluginUpdatePolicyV1Schema>;

/**
 * The user's update review preference, one per Account, applied by the
 * daemon's authority-delta classifier to every managed update (marketplace,
 * npm, archive, and local path installs).
 *
 * `confirmAccessChanges` asks before an update widens user-granted reach
 * (host access, Connected Account purposes, request interceptors, raw
 * credentials). `autoApply` applies such updates without asking. New
 * contributions and executable realms of already-trusted code never ask, and
 * development plugins never ask on change, in either mode. The per-plugin
 * `allowed | pinned` eligibility above is independent of this preference.
 */
export const PluginUpdateReviewModeV1Schema = lazyZodSchema(() => z.enum([
  'confirmAccessChanges',
  'autoApply',
]));
export type PluginUpdateReviewModeV1 = z.infer<typeof PluginUpdateReviewModeV1Schema>;
export const DEFAULT_PLUGIN_UPDATE_REVIEW_MODE_V1: PluginUpdateReviewModeV1 = 'confirmAccessChanges';
