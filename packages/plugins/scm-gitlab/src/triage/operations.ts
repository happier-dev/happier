/**
 * The three bound source Actions.
 *
 * This is the composition root of the GitLab Triage vertical and the only place
 * that reads the ambient clock: every module below it takes `nowMs` so a
 * provider deadline stays testable. Each handler strictly parses its published
 * input, performs exactly one requested read, and parses its own result through
 * the published schema — an internal mapping defect fails loudly here instead of
 * reaching the aggregate as a plausible-looking observation.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriageGetInputV1Schema,
  TriageGetResultV1Schema,
  TriageListInstancesInputV1Schema,
  TriageListInstancesResultV1Schema,
  TriagePrepareReviewWorkspaceInputV1Schema,
  TriagePrepareReviewWorkspaceResultV1Schema,
  TriageScanInputV1Schema,
  TriageScanResultV1Schema,
  TriageVerifyReviewWorkspaceInputV1Schema,
  TriageVerifyReviewWorkspaceResultV1Schema,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriagePrepareReviewWorkspaceResultV1,
  type TriageScanResultV1,
  type TriageVerifyReviewWorkspaceResultV1,
} from '@happier-dev/triage-protocol/v1';

import { createGitlabHttpFetcher, readGitlabConnectedAccounts } from './invocation.js';
import { getGitlabTriageEntry } from './sourceGet.js';
import { listGitlabTriageInstances } from './sourceInstances.js';
import { scanGitlabTriageSource } from './sourceScan.js';
import {
  prepareGitlabReviewWorkspace,
  verifyGitlabReviewWorkspace,
} from './reviewWorkspace.js';

/**
 * The host validates operation input against the published schema before
 * dispatch, so a value that fails here is a broken contract rather than a
 * provider condition — and the source result unions describe provider outcomes
 * only. It is raised, never mapped onto a typed failure that would tell the
 * user GitLab was at fault.
 */
function requireOperationInput<T>(
  parsed: Readonly<{ success: true; data: T }> | Readonly<{ success: false; error: unknown }>,
  role: string,
): T {
  if (!parsed.success) throw new TypeError(`gitlab_triage_invalid_operation_input:${role}`);
  return parsed.data;
}

export async function listGitlabInstancesAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageListInstancesResultV1> {
  requireOperationInput(TriageListInstancesInputV1Schema.safeParse(input), 'listInstances');
  const result = await listGitlabTriageInstances({
    connectedAccounts: readGitlabConnectedAccounts(context),
    signal: context.signal,
  });
  return TriageListInstancesResultV1Schema.parse(result);
}

export async function scanGitlabSourceAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageScanResultV1> {
  const scan = requireOperationInput(TriageScanInputV1Schema.safeParse(input), 'scan');
  const result = await scanGitlabTriageSource({
    scan,
    connectedAccounts: readGitlabConnectedAccounts(context),
    fetcher: createGitlabHttpFetcher(context),
    signal: context.signal,
    nowMs: Date.now(),
  });
  return TriageScanResultV1Schema.parse(result);
}

export async function getGitlabSourceEntryAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageGetResultV1> {
  const get = requireOperationInput(TriageGetInputV1Schema.safeParse(input), 'get');
  const result = await getGitlabTriageEntry({
    get,
    connectedAccounts: readGitlabConnectedAccounts(context),
    fetcher: createGitlabHttpFetcher(context),
    signal: context.signal,
    nowMs: Date.now(),
  });
  return TriageGetResultV1Schema.parse(result);
}

export async function prepareGitlabReviewWorkspaceAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriagePrepareReviewWorkspaceResultV1> {
  const preparation = requireOperationInput(
    TriagePrepareReviewWorkspaceInputV1Schema.safeParse(input),
    'prepareReviewWorkspace',
  );
  const result = await prepareGitlabReviewWorkspace(preparation, context);
  return TriagePrepareReviewWorkspaceResultV1Schema.parse(result);
}

export async function verifyGitlabReviewWorkspaceAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageVerifyReviewWorkspaceResultV1> {
  const verification = requireOperationInput(
    TriageVerifyReviewWorkspaceInputV1Schema.safeParse(input),
    'verifyReviewWorkspace',
  );
  const result = await verifyGitlabReviewWorkspace(verification, context);
  return TriageVerifyReviewWorkspaceResultV1Schema.parse(result);
}
