import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ForgeCiJobRefV1,
  ForgeCiOperationIdV1,
  ForgeCiSelectionV1,
} from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiAdapterV1 } from '../../runtime/adapter.js';
import type { ForgeCiReadsV1 } from '../../runtime/reads.js';
import type { ForgeCiStateSubjectV1 } from './ForgeCiStateNotice.js';

/**
 * Everything a shared CI view needs from the forge plugin that mounts it, built once per mount by that plugin
 * (GitHub's `useGithubCiBindingV1`). The views stay forge-neutral: they read through `reads`, write through
 * the host's physical controls with `actionRefs`, retain `adapter` for automation, download through the host,
 * and speak the forge and account names from `about`.
 */
export type ForgeCiBindingV1 = Readonly<{
  reads: ForgeCiReadsV1 | null;
  adapter: ForgeCiAdapterV1 | null;
  actionRefs: Readonly<
    Record<ForgeCiOperationIdV1, PluginContributionRef | null>
  >;
  about: Omit<ForgeCiStateSubjectV1, 'subject'>;
  /** The exact Connected Account the reads use, for sign-in repair; null when the host has not admitted one. */
  account: ConnectedAccountRef | null;
  /**
   * The one "Fix in a session" handoff (plan 05): the forge plugin hands the admitted failure to its configured
   * handoff. Absent means this host cannot hand failures to a session, and the control is not drawn.
   */
  fix?: (
    target: Readonly<{ selection: ForgeCiSelectionV1; job?: ForgeCiJobRefV1 }>,
  ) => unknown;
}>;
