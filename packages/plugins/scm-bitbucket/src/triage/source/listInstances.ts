import { readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';
import {
  type TriageListInstancesResultV1,
  type TriageSourceAccountBindingV1,
  type TriageSourceFailureV1,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

import { createBitbucketFailure } from '../failures.js';
import { encodeBitbucketConfiguration } from '../instance.js';
import { listBitbucketWorkspaces } from '../pullRequests.js';
import type { BitbucketWorkspaceRef } from '../entries.js';
import {
  classifyBitbucketAuthorizationThrow,
  createAuthorizedBitbucketClient,
  type BitbucketSourceRuntime,
} from './authorization.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import { toTriageSourceFailure } from './failures.js';

type InstanceFailure = TriageListInstancesResultV1 extends infer TResult
  ? TResult extends Readonly<{ failures: readonly (infer TFailure)[] }> ? TFailure : never
  : never;

const BITBUCKET_WEB_ORIGIN = 'https://bitbucket.org';

function buildLocator(workspace: BitbucketWorkspaceRef): TriageSourceInstanceDraftV1['locator'] {
  const displayLabel = workspace.name ?? workspace.slug ?? workspace.uuid;
  return {
    v: 1,
    displayLabel,
    ...(workspace.slug === null ? {} : { displayPath: workspace.slug }),
    ...(workspace.slug === null
      ? {}
      : { webUrl: `${BITBUCKET_WEB_ORIGIN}/${encodeURIComponent(workspace.slug)}` }),
  };
}

/**
 * Discovery for every Bitbucket account currently authorized for this source's declared purpose.
 *
 * Each authorized account is an enumeration parent, not an instance: one candidate exists per exact
 * `(purpose, account)` binding × immutable workspace UUID. The workspace slug and name are locator
 * facts on the same key, so a workspace rename produces the same candidate with different display
 * text rather than a new one.
 *
 * This operation never writes a configured row. Creation, reconfiguration, removal, and
 * reactivation are the target's explicit user-intent administration Action.
 */
export async function listBitbucketSourceInstances(
  runtime: BitbucketSourceRuntime,
): Promise<TriageListInstancesResultV1> {
  const outcome = await readTriageSourceAccountListingV1({
    connectedAccounts: runtime.connectedAccounts,
    purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (outcome.kind === 'failed') {
    return {
      kind: 'failed',
      failure: toTriageSourceFailure(outcome.reason === 'deadline'
        ? createBitbucketFailure('transient', 'invocation-deadline-exceeded')
        : outcome.reason === 'cancelled'
          ? createBitbucketFailure('cancelled', 'invocation-cancelled')
          : classifyBitbucketAuthorizationThrow(outcome.error)),
    };
  }
  // A purpose with no selected account has an empty authorized set. Bitbucket was
  // never asked, so it is not what refused the reader.
  const listing: Awaited<ReturnType<BitbucketSourceRuntime['connectedAccounts']['listAccounts']>>
    = outcome.kind === 'unbound' ? { status: 'complete', accounts: [] } : outcome.listing;

  const candidates: TriageSourceInstanceDraftV1[] = [];
  const failures: InstanceFailure[] = [];
  // A truncated metadata listing has no resumable cursor, so some authorized account may be
  // unrepresented and the whole result is honestly incomplete rather than a shorter complete set.
  let complete = listing.status === 'complete';
  let incompleteFailure: TriageSourceFailureV1 | undefined = complete
    ? undefined
    : { class: 'unsupportedContract', code: 'account-listing-truncated' };

  const recordFailure = (
    binding: TriageSourceAccountBindingV1,
    failure: TriageSourceFailureV1,
    localInstanceKey?: string,
  ): void => {
    failures.push({
      binding,
      ...(localInstanceKey === undefined ? {} : { localInstanceKey }),
      failure,
    } as InstanceFailure);
  };

  for (const listed of listing.accounts) {
    const binding: TriageSourceAccountBindingV1 = {
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      account: listed.account,
    };

    if (listed.state !== 'connected') {
      // A known-unhealthy account is an explicit exact-binding failure, not a silent omission and
      // not a reason to call the whole enumeration incomplete.
      recordFailure(binding, toTriageSourceFailure(createBitbucketFailure(
        'authentication',
        'account-not-connected',
        { detail: listed.state },
      )));
      continue;
    }

    const authorized = await createAuthorizedBitbucketClient(runtime, {
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      account: listed.account,
    });
    if (!authorized.ok) {
      recordFailure(binding, toTriageSourceFailure(authorized.failure));
      continue;
    }

    const workspaces = await listBitbucketWorkspaces({
      client: authorized.client,
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
    if (!workspaces.ok) {
      const failure = toTriageSourceFailure(workspaces.failure);
      recordFailure(binding, failure);
      complete = false;
      incompleteFailure ??= failure;
      continue;
    }
    if (workspaces.failure !== undefined) {
      const failure = toTriageSourceFailure(workspaces.failure);
      recordFailure(binding, failure);
      complete = false;
      incompleteFailure ??= failure;
    }

    for (const workspace of workspaces.workspaces) {
      const configuration = encodeBitbucketConfiguration({ v: 1, workspaceUuid: workspace.uuid });
      if (!configuration.ok) {
        recordFailure(
          binding,
          toTriageSourceFailure(createBitbucketFailure(
            'unsupportedContract',
            'configuration-unencodable',
            { detail: configuration.reason },
          )),
          workspace.uuid,
        );
        continue;
      }
      candidates.push({
        v: 1,
        binding,
        // The immutable workspace UUID verbatim, braces included: it survives a rename, and it
        // re-encodes neither the purpose nor the account ref.
        localInstanceKey: workspace.uuid,
        keyStability: 'stable',
        configuration: { v: 1, token: configuration.token },
        locator: buildLocator(workspace),
      });
    }
  }

  if (complete) {
    return { kind: 'complete', candidates, failures };
  }
  return {
    kind: 'incomplete',
    candidates,
    failures,
    ...(incompleteFailure === undefined ? {} : { failure: incompleteFailure }),
  };
}
