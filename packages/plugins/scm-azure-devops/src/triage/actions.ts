import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import {
  TriageGetInputV1Schema,
  TriageListInstancesInputV1Schema,
  TriageScanInputV1Schema,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import { createAzureSourceFailure } from './failureProjection.js';
import {
  runAzureTriageGet,
  runAzureTriageListInstances,
  runAzureTriageScan,
  type AzureTriageReadServices,
} from './operations.js';
import type { AzureDevOpsHttpRequest, AzureDevOpsHttpResponse } from './types.js';

/**
 * The Action ids that carry this source's three required V1 roles.
 *
 * They are plugin-local ids; the qualified handle is the host's, and the role binding lives in the
 * manifest contribution. `descriptor.ts` re-exports nothing here — this module is the single
 * owner, so a declared Action and a registered handler cannot drift apart.
 */
export const AZURE_DEVOPS_TRIAGE_ACTION_IDS = Object.freeze({
  listInstances: 'triage-list-instances',
  scan: 'triage-scan',
  get: 'triage-get',
});

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Adapt the host HTTP service to this source's one transport seam.
 *
 * `redirect: 'error'` is deliberate and is the whole reason this adapter exists rather than a
 * direct call: Azure answers an unusable credential with a redirect to a sign-in host, and a
 * followed redirect would deliver that page's HTML as if it were an API response.
 */
function toTransport(http: HttpService, signal: AbortSignal) {
  return async (request: AzureDevOpsHttpRequest): Promise<AzureDevOpsHttpResponse> => {
    const response = await http.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined
        ? {}
        : { body: new TextEncoder().encode(request.body) }),
      redirect: 'error',
    }, { signal });
    return {
      status: response.status,
      headers: response.headers,
      bodyText: TEXT_DECODER.decode(response.body),
    };
  };
}

function toReadServices(context: PluginInvocationContext): AzureTriageReadServices {
  return {
    connectedAccounts: context.services.connectedAccounts,
    transport: toTransport(context.services.http, context.signal),
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
 * The three source role handlers.
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
