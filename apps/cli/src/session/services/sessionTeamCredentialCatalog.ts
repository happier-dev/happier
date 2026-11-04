import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { TeamCredentialResourcePageV1Schema,
  type TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { projectTeamCredentialLaunchFailure, readTeamCredentialLaunchFailureCode,
  SessionTeamCredentialLaunchUnavailableError, type TeamCredentialLaunchFailurePhase } from './sessionTeamCredentialLaunchError';

async function readCatalogPage(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  request: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0];
  phase: TeamCredentialLaunchFailurePhase;
  signal?: AbortSignal;
}>): Promise<unknown> {
  let raw: unknown;
  try { raw = await input.homeDomainAction(input.request); }
  catch (error) {
    input.signal?.throwIfAborted();
    throw projectTeamCredentialLaunchFailure(error, input.phase, 'provider_catalog_unavailable');
  }
  if (raw && typeof raw === 'object' && (('ok' in raw && raw.ok === false) || 'error' in raw)) {
    throw new SessionTeamCredentialLaunchUnavailableError(
      readTeamCredentialLaunchFailureCode(raw) ?? 'provider_catalog_unavailable', input.phase,
    );
  }
  return raw;
}

/** Authenticated custodian selection shares the recipient catalog transport;
 * the Home, not a daemon-wide Team census, selects the affected sources. */
export async function readCustodianTeamCredentialDirectResources(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  signal?: AbortSignal;
}>): Promise<readonly TeamCredentialResourceSummaryV1[]> {
  const resources: TeamCredentialResourceSummaryV1[] = [];
  let cursor: string | null = null;
  do {
    input.signal?.throwIfAborted();
    const raw = await readCatalogPage({ ...input, phase: 'resource_catalog', request: {
      actionId: 'teams.credentials.list', input: { scope: 'custodian', filter: 'direct', ...(cursor ? { cursor } : {}) },
      context: { surface: 'cli' }, ...(input.signal ? { signal: input.signal } : {}),
    } });
    const parsed = createStoredReadSchema(TeamCredentialResourcePageV1Schema).safeParse(raw);
    if (!parsed.success) throw new SessionTeamCredentialLaunchUnavailableError('provider_rpc_response_invalid', 'resource_catalog');
    resources.push(...parsed.data.resources);
    cursor = parsed.data.nextCursor;
  } while (cursor);
  return resources;
}
