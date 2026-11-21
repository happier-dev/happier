import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ConnectedAccountActionFormSelectionV1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { createGithubApiClient, decodeGithubJsonResponse, type GithubApiResponseV1 } from './observations/githubApiClient.js';
import type { GithubHttpInvocationContextV1 } from './observations/githubHttpInvocation.js';
import { githubRepositoryUrl } from './observations/githubRepositoryResolution.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from './observations/githubResponseFailure.js';
import { createGithubRepositorySourceConfig, GITHUB_API_ORIGIN, GithubAutomationRepositorySourceConfigV1Schema, tryReadGithubPositiveDecimal } from './observations/githubProviderContracts.js';

/** Private writer input. The host binds it to the authenticated endpoint operation before invocation. */
type ManagedRepositoryWebhookOperation = Readonly<{
  repositoryId: string;
  credentialRef: ConnectedAccountActionFormSelectionV1;
}> & (
  | Readonly<{ kind: 'register'; publicUrl: string; signingSecret: string }>
  | Readonly<{ kind: 'remove'; hookId: string }>
);

type ManagedRepositoryWebhookResult =
  | Readonly<{ kind: 'registered'; hookId: string }>
  | Readonly<{ kind: 'removed' }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

export function readGithubManagedRepositoryHookSource(sourceInstanceId: string, sourceConfig: unknown) {
  const parsed = GithubAutomationRepositorySourceConfigV1Schema.safeParse(sourceConfig);
  if (!parsed.success || sourceInstanceId !== `github:repository:${parsed.data.repository.repositoryId}`) return null;
  return { repositoryId: parsed.data.repository.repositoryId, credentialRef: parsed.data.credentialRef };
}

const unavailable = (code: string): ManagedRepositoryWebhookResult => ({ kind: 'unavailable', code });

function projectGithubWebhookRefusal(response: GithubApiResponseV1, writableResource: boolean): ManagedRepositoryWebhookResult {
  const refusal = classifyGithubResponseFailure(response, Date.now());
  if (refusal.class === 'authentication') {
    return unavailable(CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired);
  }
  if (refusal.class === 'permission' || writableResource && response.status === 404) {
    return unavailable(CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialScopeMissing);
  }
  return unavailable(refusal.code);
}

/** GitHub is the one owner of provider semantics. Only its sanitized result crosses the Home RPC. */
export async function writeGithubManagedRepositoryWebhook(
  context: GithubHttpInvocationContextV1,
  operation: ManagedRepositoryWebhookOperation,
): Promise<ManagedRepositoryWebhookResult> {
  if (tryReadGithubPositiveDecimal(operation.repositoryId) === null
    || operation.kind === 'remove' && tryReadGithubPositiveDecimal(operation.hookId) === null) return unavailable('github_webhook_source_invalid');
  try {
    context.signal.throwIfAborted();
    const client = await createGithubApiClient(context, operation.credentialRef);
    const byId = await client.request({ url: new URL(`/repositories/${operation.repositoryId}`, GITHUB_API_ORIGIN).toString() });
    if (byId.status !== 200) return projectGithubWebhookRefusal(byId, false);
    const repository = createGithubRepositorySourceConfig(decodeGithubJsonResponse(byId));
    if (repository.repositoryId !== operation.repositoryId) return unavailable('github_webhook_source_invalid');

    const hooksUrl = `${githubRepositoryUrl(repository)}/hooks`;
    if (operation.kind === 'remove') {
      const response = await client.request({ method: 'DELETE', url: `${hooksUrl}/${operation.hookId}` });
      if (response.status === 204) return { kind: 'removed' };
      // GitHub may mask a lost grant as a 404. Report the refusal so the owner can check for a leftover hook.
      return projectGithubWebhookRefusal(response, false);
    }
    const url = new URL(operation.publicUrl);
    if (url.protocol !== 'https:') return unavailable('route_unavailable');
    const response = await client.request({
      method: 'POST',
      url: hooksUrl,
      headers: { 'Content-Type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ name: 'web', active: true, events: ['push'],
        config: { url: url.toString(), content_type: 'json', secret: operation.signingSecret, insecure_ssl: '0' } })),
    });
    if (response.status !== 201) return projectGithubWebhookRefusal(response, true);
    const record = decodeGithubJsonResponse(response);
    const id = record && typeof record === 'object' && 'id' in record ? record.id : undefined;
    const hookId = tryReadGithubPositiveDecimal(id);
    return hookId === null ? unavailable('github_webhook_result_invalid') : { kind: 'registered', hookId };
  } catch (error) {
    context.signal.throwIfAborted();
    const refusal = classifyGithubTransportFailure(error);
    return unavailable(refusal.class === 'authentication'
      ? CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
      : refusal.code);
  }
}
