import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriageGetInputV1Schema,
  TriageListInstancesInputV1Schema,
  TriageScanInputV1Schema,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import { createBitbucketFailure } from '../failures.js';
import { toTriageSourceFailure } from './failures.js';
import { getBitbucketSourceEntry } from './get.js';
import { listBitbucketSourceInstances } from './listInstances.js';
import { scanBitbucketSource } from './scan.js';
import type { BitbucketSourceRuntime } from './authorization.js';

/**
 * The Action ids that carry this source's three required V1 roles. They are plugin-local ids; the
 * qualified handle is the host's, and the role binding lives in the manifest contribution.
 */
export const BITBUCKET_TRIAGE_ACTION_IDS = Object.freeze({
  listInstances: 'triage-list-instances',
  scan: 'triage-scan',
  get: 'triage-get',
});

function toRuntime(context: PluginInvocationContext): BitbucketSourceRuntime {
  return {
    connectedAccounts: context.services.connectedAccounts,
    http: context.services.http,
    now: () => Date.now(),
    signal: context.signal,
  };
}

const INVALID_INPUT = createBitbucketFailure('unsupportedContract', 'operation-input-invalid');

/**
 * The three source role handlers.
 *
 * Each parses its input through the published schema before touching a provider. The host already
 * validates against the same declared JSON Schema, so this is not a second admission authority: it
 * is how the source obtains a typed value it can route on without trusting an untyped bag.
 *
 * Each handler reads only its invocation context, so no activation-scoped runtime holds a
 * credential, a client, or a scan frontier between invocations.
 */
export async function listBitbucketInstancesAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageListInstancesResultV1> {
  const parsed = TriageListInstancesInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'failed', failure: toTriageSourceFailure(INVALID_INPUT) };
  return await listBitbucketSourceInstances(toRuntime(context));
}

export async function scanBitbucketSourceAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageScanResultV1> {
  const parsed = TriageScanInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'failed', failure: toTriageSourceFailure(INVALID_INPUT) };
  return await scanBitbucketSource(toRuntime(context), parsed.data);
}

export async function getBitbucketSourceEntryAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageGetResultV1> {
  const parsed = TriageGetInputV1Schema.safeParse(input);
  if (!parsed.success) {
    // Without a valid input ref there is no ref to report `unresolved` against, so the malformed
    // invocation is refused rather than answered about an invented entry.
    throw new TypeError('Bitbucket triage get received an invalid input');
  }
  return await getBitbucketSourceEntry(toRuntime(context), parsed.data);
}
