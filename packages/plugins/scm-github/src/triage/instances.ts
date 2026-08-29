import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';
import {
  type TriageListInstancesResultV1,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

import {
  decodeGithubJsonResponse,
  createGithubListedAccountApiClient,
} from '../observations/githubApiClient.js';
import {
  GITHUB_API_ORIGIN,
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
} from '../observations/githubProviderContracts.js';

import {
  encodeGithubTriageConfiguration,
  GITHUB_TRIAGE_ACCOUNT_SCOPE_V1,
  GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1,
} from './configuration.js';
import { GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from './contribution.js';
import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from './errors.js';
import { readGithubAbsoluteWebUrl } from './locator.js';
import { toTriageFailure } from './mapping/protocol.js';
import type { GithubTriageFailureV1 } from './types.js';

/**
 * GitHub discovery: one non-durable candidate per authorized Connected Account.
 *
 * Discovery reads only the generic bounded account-metadata listing for this
 * source's own declared purpose. It never enumerates GitHub users, never invents a
 * cursor the incumbent owner does not have, and never writes a configured instance:
 * a candidate stays a Settings choice until the user invokes the target-owned
 * administration Action. A truncated listing is reported as `incomplete` rather
 * than silently dropping an account the user has configured.
 *
 * A purpose with no selected account is an empty `complete` set, not a failure.
 * The host declines to list an unbound purpose, and the shared listing owner
 * separates that decline from a real refusal by re-asking the same authorized
 * target through the nullable question. Calling it a GitHub failure would accuse
 * a provider this source never contacted, and would hide the one thing the
 * reader can act on: connecting an account.
 */

export type GithubTriageInstancesDependenciesV1 = Readonly<{
  /** Injected clock; a provider-directed retry instant is never guessed. */
  now?: () => number;
}>;

type CandidateOutcome =
  | Readonly<{ kind: 'candidate'; draft: TriageSourceInstanceDraftV1 }>
  | Readonly<{ kind: 'failed'; failure: GithubTriageFailureV1 }>;

type GithubAccountIdentity = Readonly<{ login: string; webUrl: string | null }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAccountIdentity(body: unknown): GithubAccountIdentity | null {
  if (!isRecord(body)) return null;
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  if (!login) return null;
  return Object.freeze({ login, webUrl: readGithubAbsoluteWebUrl(body.html_url) });
}

/**
 * Reauthorizes one exact listed account and reads its identity. The read is the
 * candidate's display authority: no display fact is copied from the host's account
 * metadata, and no candidate exists without a current authorized provider response.
 */
async function readCandidate(
  account: ConnectedAccountRef,
  context: PluginInvocationContext,
  now: () => number,
): Promise<CandidateOutcome> {
  let identity: GithubAccountIdentity | null;
  try {
    const client = await createGithubListedAccountApiClient(context, account);
    const response = await client.request({ url: `${GITHUB_API_ORIGIN}/user` });
    if (!isGithubSuccessStatus(response.status)) {
      return Object.freeze({
        kind: 'failed' as const,
        failure: classifyGithubResponseFailure(response, now()),
      });
    }
    identity = readAccountIdentity(decodeGithubJsonResponse(response));
  } catch (error) {
    return Object.freeze({ kind: 'failed' as const, failure: classifyGithubTransportFailure(error) });
  }
  if (identity === null) {
    return Object.freeze({
      kind: 'failed' as const,
      failure: Object.freeze({
        class: 'unsupportedContract' as const,
        code: 'github_account_identity_invalid',
      }),
    });
  }
  const token = encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1);
  if (token === null) {
    return Object.freeze({
      kind: 'failed' as const,
      failure: Object.freeze({
        class: 'unsupportedContract' as const,
        code: 'github_configuration_unencodable',
      }),
    });
  }
  return Object.freeze({
    kind: 'candidate' as const,
    draft: Object.freeze({
      v: 1 as const,
      binding: Object.freeze({
        purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose,
        account,
      }),
      // The source-native scope only. GitHub's deployment is the whole scope a
      // discovery candidate can prove; the account ref stays in `binding`, so two
      // accounts legitimately produce two candidates under this same key.
      localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1,
      // Derived from the configured normalized API origin, not from immutable
      // provider identity: an origin change is explicit reconfiguration.
      keyStability: 'locatorDerived' as const,
      configuration: Object.freeze({ v: 1 as const, token }),
      locator: Object.freeze({
        v: 1 as const,
        displayLabel: identity.login,
        ...(identity.webUrl === null ? {} : { webUrl: identity.webUrl }),
      }),
    }),
  });
}

export async function listGithubTriageInstances(
  context: PluginInvocationContext,
  dependencies: GithubTriageInstancesDependenciesV1 = {},
): Promise<TriageListInstancesResultV1> {
  const now = dependencies.now ?? Date.now;
  const listing = await readTriageSourceAccountListingV1({
    connectedAccounts: context.services.connectedAccounts,
    purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    signal: context.signal,
  });
  if (listing.kind === 'failed') {
    // The source learned nothing about its configured accounts, which is not the
    // same as learning that there are none.
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(listing.reason === 'deadline'
        ? Object.freeze({ class: 'transient' as const, code: 'github_request_timed_out' })
        : listing.reason === 'cancelled'
          ? Object.freeze({ class: 'transient' as const, code: 'github_request_cancelled' })
          : classifyGithubTransportFailure(listing.error)),
    });
  }
  const listed = listing.kind === 'unbound'
    ? Object.freeze({ status: 'complete' as const, accounts: Object.freeze([]) })
    : listing.listing;

  const candidates: TriageSourceInstanceDraftV1[] = [];
  const failures: Array<Readonly<{
    binding: TriageSourceInstanceDraftV1['binding'];
    failure: ReturnType<typeof toTriageFailure>;
  }>> = [];
  for (const listedAccount of listed.accounts) {
    const outcome = await readCandidate(listedAccount.account, context, now);
    if (outcome.kind === 'candidate') {
      candidates.push(outcome.draft);
      continue;
    }
    failures.push(Object.freeze({
      binding: Object.freeze({
        purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose,
        account: listedAccount.account,
      }),
      failure: toTriageFailure(outcome.failure),
    }));
  }

  const frozenCandidates = Object.freeze([...candidates]);
  const frozenFailures = Object.freeze([...failures]);
  // The incumbent metadata owner has no resumable cursor, so a truncated listing
  // can never be completed by another call: it is reported as incomplete instead of
  // presenting a short list as the user's whole configured set.
  return listed.status === 'truncated'
    ? Object.freeze({
      kind: 'incomplete' as const,
      candidates: frozenCandidates,
      failures: frozenFailures,
      failure: Object.freeze({
        class: 'unsupportedContract' as const,
        code: 'github_account_listing_truncated',
      }),
    })
    : Object.freeze({
      kind: 'complete' as const,
      candidates: frozenCandidates,
      failures: frozenFailures,
    });
}
