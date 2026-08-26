/**
 * `listInstances` — read-only discovery of the GitLab deployments each
 * authorized account can reach.
 *
 * Three rules this operation exists to keep:
 *
 * 1. **The bounded metadata listing is the whole account set.** There is no
 *    cursor to resume, so a truncated listing settles `incomplete` rather than
 *    presenting a short list as the complete one.
 * 2. **An origin is read, never defaulted.** A configured account that names no
 *    origin produces an attributed failure. Assuming `gitlab.com` because a host
 *    looked familiar is how a credential reaches the wrong deployment.
 * 3. **Discovery writes nothing.** A candidate is a Settings choice; only the
 *    target-owned administration Action creates a configured instance.
 */

import { readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';
import type {
  TriageListInstancesResultV1,
  TriageSourceAccountBindingV1,
  TriageSourceFailureV1,
  TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GITLAB_CONFIGURATION_RECORD_V1,
  encodeGitlabConfiguration,
} from './configuration.js';
import { GITLAB_CONNECTED_ACCOUNT_PURPOSE } from './contribution.js';
import type { GitlabConnectedAccounts } from './http/gitlabClient.js';
import { admitGitlabV1Deployment, normalizeGitlabConfiguredBaseUrl } from './origin.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';

type InstanceFailure = Readonly<{
  binding: TriageSourceAccountBindingV1;
  localInstanceKey?: string;
  failure: TriageSourceFailureV1;
}>;

/** Host-owned connection states that cannot answer a provider read today. */
const UNUSABLE_ACCOUNT_STATES: Readonly<Record<string, string>> = Object.freeze({
  expired: 'The configured GitLab account credential has expired.',
  reconnectRequired: 'The configured GitLab account must be reconnected.',
  unavailable: 'The configured GitLab account is unavailable.',
});

export type GitlabListInstancesInput = Readonly<{
  connectedAccounts: GitlabConnectedAccounts;
  signal: AbortSignal;
}>;

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}

export async function listGitlabTriageInstances(
  input: GitlabListInstancesInput,
): Promise<TriageListInstancesResultV1> {
  const outcome = await readTriageSourceAccountListingV1({
    connectedAccounts: input.connectedAccounts,
    purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    signal: input.signal,
  });
  if (outcome.kind === 'failed') {
    // The source learned nothing at all: not an empty account set.
    return {
      kind: 'failed',
      failure: {
        class: isAbortError(outcome.error) ? 'transient' : 'unknown',
        code: isAbortError(outcome.error) ? 'cancelled' : 'account-listing-failed',
        detail: 'The authorized GitLab accounts could not be listed.',
      },
    };
  }
  // A purpose with no selected account is an empty set the reader can act on by
  // connecting one — never a GitLab that refused a request nobody sent.
  const listing = outcome.kind === 'unbound'
    ? { status: 'complete' as const, accounts: [] }
    : outcome.listing;

  const candidates: TriageSourceInstanceDraftV1[] = [];
  const failures: InstanceFailure[] = [];

  for (const listed of listing.accounts) {
    const binding: TriageSourceAccountBindingV1 = {
      purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      account: listed.account,
    };

    const unusableDetail = UNUSABLE_ACCOUNT_STATES[listed.state];
    if (unusableDetail !== undefined) {
      failures.push({
        binding,
        failure: {
          class: 'authentication',
          code: 'account-not-connected',
          detail: unusableDetail,
        },
      });
      continue;
    }

    if (listed.connectedAccountOrigins.length === 0) {
      failures.push({
        binding,
        failure: {
          class: 'unsupportedContract',
          code: 'configured-origin-unavailable',
          detail: 'The configured GitLab account names no deployment origin.',
        },
      });
      continue;
    }

    for (const configuredOrigin of listed.connectedAccountOrigins) {
      const normalized = normalizeGitlabConfiguredBaseUrl(configuredOrigin);
      const admission = admitGitlabV1Deployment(configuredOrigin);
      if (admission.kind === 'rejected') {
        // V1 stops here, before any item call: no version read, no edition
        // inference, no per-endpoint fallback.
        failures.push({
          binding,
          ...(normalized === null ? {} : { localInstanceKey: normalized.normalized }),
          failure: projectGitlabSourceFailure(admission.failure),
        });
        continue;
      }

      candidates.push({
        v: 1,
        binding,
        // The source-native scope, and only that. The account is already a
        // separate member of the target's matching tuple; re-encoding it here
        // would create a second account-identity carrier.
        localInstanceKey: admission.origin.normalized,
        keyStability: 'locatorDerived',
        configuration: encodeGitlabConfiguration(GITLAB_CONFIGURATION_RECORD_V1),
        locator: {
          v: 1,
          displayLabel: listed.displayName.trim() === ''
            ? admission.origin.forgeHostId
            : listed.displayName,
          displayPath: admission.origin.forgeHostId,
          webUrl: admission.origin.normalized,
        },
      });
    }
  }

  if (listing.status === 'truncated') {
    return {
      kind: 'incomplete',
      candidates,
      failures,
      failure: {
        class: 'unknown',
        code: 'account-listing-truncated',
        detail: 'The authorized GitLab account listing was truncated and cannot be resumed.',
      },
    };
  }

  return { kind: 'complete', candidates, failures };
}
