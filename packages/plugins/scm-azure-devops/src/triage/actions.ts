import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriageGetInputV1Schema,
  TriageListInstancesInputV1Schema,
  TriagePrepareReviewWorkspaceInputV1Schema,
  TriageScanInputV1Schema,
  TriageVerifyReviewWorkspaceInputV1Schema,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriagePrepareReviewWorkspaceResultV1,
  type TriageScanResultV1,
  type TriageVerifyReviewWorkspaceResultV1,
} from '@happier-dev/triage-protocol/v1';

import { createAzureSourceFailure } from './failureProjection.js';
import { toAzureTransport } from './invocation.js';
import {
  runAzureTriageGet,
  runAzureTriageListInstances,
  runAzureTriagePrepareReviewWorkspace,
  runAzureTriageScan,
  runAzureTriageVerifyReviewWorkspace,
  type AzureTriageReadServices,
} from './operations.js';

/**
 * The Action ids that carry this source's three required V1 reads and its two review-workspace
 * roles.
 *
 * They are plugin-local ids; the qualified handle is the host's, and the role binding lives in the
 * manifest contribution. `descriptor.ts` re-exports nothing here — this module is the single
 * owner, so a declared Action and a registered handler cannot drift apart.
 */
export const AZURE_DEVOPS_TRIAGE_ACTION_IDS = Object.freeze({
  listInstances: 'triage-list-instances',
  scan: 'triage-scan',
  get: 'triage-get',
  prepareReviewWorkspace: 'triage-prepare-review-workspace',
  verifyReviewWorkspace: 'triage-verify-review-workspace',
});

function toReadServices(context: PluginInvocationContext): AzureTriageReadServices {
  return {
    connectedAccounts: context.services.connectedAccounts,
    transport: toAzureTransport(context.services.http, context.signal),
    now: () => Date.now(),
  };
}

function invalidInput(detail: string) {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/operation-input-invalid',
    detail,
  });
}

/**
 * The source role handlers.
 *
 * Each parses its input through the published schema before touching a provider. The host already
 * validates against the same declared JSON Schema, so this is not a second admission authority: it
 * is how the source obtains a typed value it can route on without trusting an untyped bag.
 *
 * Each handler reads only its own invocation context, so nothing activation-scoped holds a
 * credential, a client, or a scan frontier between invocations.
 */
export async function listAzureDevOpsInstancesAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageListInstancesResultV1> {
  if (!TriageListInstancesInputV1Schema.safeParse(input).success) {
    return {
      kind: 'failed',
      failure: invalidInput('This Azure DevOps discovery input is not the published V1 shape.'),
    };
  }
  return await runAzureTriageListInstances({
    connectedAccounts: context.services.connectedAccounts,
    signal: context.signal,
  });
}

export async function scanAzureDevOpsSourceAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageScanResultV1> {
  const parsed = TriageScanInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      kind: 'failed',
      failure: invalidInput('This Azure DevOps scan input is not the published V1 shape.'),
    };
  }
  return await runAzureTriageScan({
    services: toReadServices(context),
    request: parsed.data,
    signal: context.signal,
  });
}

export async function getAzureDevOpsSourceEntryAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageGetResultV1> {
  const parsed = TriageGetInputV1Schema.safeParse(input);
  if (!parsed.success) {
    // Without a valid input ref there is no ref to report `unresolved` against, so the malformed
    // invocation is refused rather than answered about an invented entry.
    throw new TypeError('Azure DevOps triage get received an invalid input');
  }
  return await runAzureTriageGet({
    services: toReadServices(context),
    request: parsed.data,
    signal: context.signal,
  });
}

/**
 * Performs the one provider-authorized review-workspace preparation operation.
 *
 * The source parser and the source owner retain provider/account/currentness authority; only
 * after that vertical calls the generic local SCM Action does any local mutation become possible.
 */
export async function prepareAzureDevOpsReviewWorkspaceAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriagePrepareReviewWorkspaceResultV1> {
  const parsed = TriagePrepareReviewWorkspaceInputV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError('Azure DevOps review-workspace preparation received an invalid input');
  }
  return await runAzureTriagePrepareReviewWorkspace({
    services: {
      ...toReadServices(context),
      actions: context.services.actions,
    },
    request: parsed.data,
    signal: context.signal,
  });
}

/**
 * Revalidates the provider revision and the already prepared local HEAD immediately before review.
 * This Action is read-only: it reuses the canonical SCM materializer's verification arm and never
 * prepares, moves, or recreates a checkout.
 */
export async function verifyAzureDevOpsReviewWorkspaceAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageVerifyReviewWorkspaceResultV1> {
  const parsed = TriageVerifyReviewWorkspaceInputV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError('Azure DevOps review-workspace verification received an invalid input');
  }
  return await runAzureTriageVerifyReviewWorkspace({
    services: {
      ...toReadServices(context),
      actions: context.services.actions,
    },
    request: parsed.data,
    signal: context.signal,
  });
}
