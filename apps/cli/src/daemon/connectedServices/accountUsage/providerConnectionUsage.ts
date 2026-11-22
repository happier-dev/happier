import { buildProviderAccountUsageOpaqueLocalCredentialRef, buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { createProviderUsageRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { resolveProviderSecretBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderSettingsV1 } from '@happier-dev/protocol';
import type { ProviderUsageSourceV1 } from '@happier-dev/protocol/providers/contributions';
import type { DaemonProviderUsageRefreshResponseV1, ProviderUsageSourceResultV1 } from '@happier-dev/protocol/rpc/providers';
import type { ProviderUsageParser } from '@happier-dev/plugin-sdk/providers';

import type { ResolvedProviderConnectionRecord } from '@/providers/registry';
import type { ProviderProbeAuthorizationPort, ProviderProbeAuthorizationRequest, ProviderProbeOperationScope } from '@/providers/probe/authorization';
import { ProviderProbeCredentialResolutionError, ProviderProbeDestinationAuthorizationError } from '@/providers/probe/authorization';
import { ProviderProbeClientError, ProviderProbeCancelledError, type ProviderUsageGetRequest, type createProviderProbeHttpClient } from '@/providers/probe/client';
import { ProviderOperationAbandonedError } from '@/providers/operationLifetime';

export type ProviderUsageParserBinding = Readonly<{
  activationOccurrenceId: string;
  parsersByFormat: Readonly<Record<string, ProviderUsageParser>>;
  isCurrent(): boolean;
}>;

/** Explicit Provider acquisition adapter for the existing Q1 snapshot owner.
 * No ledger, timer or shared Account identity is inferred from a connection key.
 */
type UsageReadCommon = Readonly<{
  parsers: ProviderUsageParserBinding;
  client: Pick<ReturnType<typeof createProviderProbeHttpClient>, 'getUsage'>;
  operationScope: ProviderProbeOperationScope;
  staleAfterMs: number;
  now?: () => number;
}>;

type UsageRequest = Omit<ProviderUsageGetRequest, 'parse' | 'signal' | 'wallDeadlineAtMs'>;
type UsageError = Extract<ProviderUsageSourceResultV1, { status: 'error' }>['error'];
type UsageAuthority = Readonly<{
  request: UsageRequest;
  readSubjectKey(): unknown;
}>;
type UsageSourceAdmission =
  | Readonly<{ status: 'ok'; authority: UsageAuthority }>
  | Readonly<{ status: 'error'; error: UsageError }>
  | Readonly<{ status: 'not_configured' }>;

type SavedUsageRead<TTicket, TCredentialRef> = UsageReadCommon & Readonly<{
  connection: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
  authorization: ProviderProbeAuthorizationPort<TTicket, TCredentialRef>;
  admitSource(sourceId: string): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: UsageError }>>;
}>;

type UsageIdentity = NonNullable<Parameters<typeof createProviderErrorV1>[1]>;

type ConnectedUsageRead = UsageReadCommon & Readonly<{
  accountSource: Readonly<{
    source: ProviderUsageSourceV1;
    identity: UsageIdentity;
    providerId: string;
    authority: UsageAuthority;
  }>;
}>;

async function prepareSavedUsageSource<TTicket, TCredentialRef>(
  input: SavedUsageRead<TTicket, TCredentialRef>,
  source: ProviderUsageSourceV1,
  hasParser: boolean,
): Promise<UsageSourceAdmission> {
  const connection = input.connection;
  const identity = { connectionId: connection.connectionId, machineId: connection.machineId };
  if (source.billingCredential && resolveProviderSecretBindingIdV1(input.providerSettings,
    connection.connectionId, connection.machineId, source.billingCredential.slotId) === null) {
    return { status: 'not_configured' };
  }
  const endpoint = connection.endpoints.find(endpoint => endpoint.endpointTemplateId === source.endpointTemplateId);
  if (!endpoint || !hasParser || connection.source.kind !== 'contribution') {
    return { status: 'error', error: createProviderErrorV1('provider_contribution_unavailable', identity) };
  }
  const request: ProviderProbeAuthorizationRequest = {
    purpose: 'usage', usageSourceId: source.id, ...identity,
    endpointTemplateId: endpoint.endpointTemplateId, endpointUrl: endpoint.normalizedUrl,
    protocol: endpoint.protocol, path: source.path, parser: source.parser,
    probeRequestFingerprint: createProviderUsageRequestFingerprintV1({
      endpointUrl: endpoint.normalizedUrl, source, publicHeaders: endpoint.publicHeaders,
    }),
  };
  const admission = await input.admitSource(source.id);
  if (!admission.ok) return { status: 'error', error: admission.error };
  const authorization = await input.authorization.authorize(request, input.operationScope);
  if (!authorization.ok) return { status: 'error', error: authorization.error };
  const credentialRef = authorization.credentialRef;
  const contributionKey = connection.source.contributionKey;
  return { status: 'ok', authority: {
    request: {
      endpointUrl: endpoint.normalizedUrl, path: source.path, publicHeaders: endpoint.publicHeaders,
      credentialPolicy: source.billingCredential || connection.source.definition.credential?.required ? 'required' : 'optional',
      authorizeDestination: async destination => {
        const validation = await input.authorization.authorizeDestination(authorization.ticket, request, destination, input.operationScope);
        if (!validation.ok) throw new ProviderProbeDestinationAuthorizationError(validation.error);
      },
      ...(credentialRef === null ? {} : { resolveCredential: async () => {
        const resolution = await input.authorization.resolveCredential(credentialRef, input.operationScope);
        if (!resolution.ok) throw new ProviderProbeCredentialResolutionError(resolution.error);
        return resolution.lease;
      } }),
    },
    readSubjectKey: () => ({ contributionKey, ...identity, sourceId: source.id,
      authorization: authorization.observationAuthorizationFingerprint }),
  } };
}

export async function refreshProviderConnectionUsage<TTicket, TCredentialRef>(
  input: SavedUsageRead<TTicket, TCredentialRef> | ConnectedUsageRead,
): Promise<DaemonProviderUsageRefreshResponseV1> {
  const read = 'accountSource' in input ? {
    identity: input.accountSource.identity, sources: [input.accountSource.source],
    providerId: input.accountSource.providerId,
    prepareSource: async () => ({ status: 'ok' as const, authority: input.accountSource.authority }),
  } : savedRead(input);
  if (!read?.sources.length) return { status: 'not_supported' };
  const { identity, sources, providerId, prepareSource } = read;
  const results: ProviderUsageSourceResultV1[] = [];
  const now = input.now ?? Date.now;
  for (const source of sources) {
    const fail = (error: UsageError) =>
      results.push({ sourceId: source.id, status: 'error', error });
    try {
      const parse = input.parsers.parsersByFormat[source.parser];
      const prepared = await prepareSource(source, Boolean(parse));
      if (prepared.status === 'not_configured') {
        results.push({ sourceId: source.id, status: 'not_configured' });
        continue;
      }
      if (prepared.status === 'error') { fail(prepared.error); continue; }
      if (!parse) { fail(createProviderErrorV1('provider_contribution_unavailable', identity)); continue; }
      const result = await input.client.getUsage({
        ...prepared.authority.request,
        parse,
        signal: input.operationScope.lifetime.signal,
        wallDeadlineAtMs: input.operationScope.lifetime.wallDeadlineAtMs,
      });
      const accountSubjectId = buildProviderAccountUsageOpaqueLocalCredentialRef({
        providerId, kind: 'connection-usage', value: JSON.stringify(prepared.authority.readSubjectKey()),
      });
      const recordKey = { providerId, accountSubjectId, subjectKind: 'unknown' as const, quotaScope: 'provider' as const };
      const observedAtMs = now();
      const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId,
        accountSubject: { kind: 'provisionalLocalSubject', id: accountSubjectId },
        observedAtMs, fetchedAtMs: observedAtMs, staleAfterMs: input.staleAfterMs,
        source: 'providerHttp', confidence: 'confirmed', state: result.meters.length ? 'loaded_data' : 'loaded_empty',
        meters: result.meters,
      });
      results.push({ sourceId: source.id, status: 'ok', snapshot });
    } catch (error) {
      if (error instanceof ProviderProbeCancelledError) throw error;
      if (error instanceof ProviderOperationAbandonedError && error.reason === 'cancelled') throw new ProviderProbeCancelledError();
      if (error instanceof ProviderProbeCredentialResolutionError || error instanceof ProviderProbeDestinationAuthorizationError) fail(error.error);
      else if (error instanceof ProviderProbeClientError) fail(createProviderErrorV1(error.code, {
        ...identity, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }));
      else fail(createProviderErrorV1(error instanceof ProviderOperationAbandonedError
        ? 'provider_endpoint_unavailable' : 'provider_probe_response_invalid', identity));
    }
  }
  return { status: 'success', sources: results };
}

function savedRead<TTicket, TCredentialRef>(input: SavedUsageRead<TTicket, TCredentialRef>) {
  const { connection } = input;
  if (connection.source.kind !== 'contribution' || connection.deployment.kind !== 'external') return null;
  return {
    identity: { connectionId: connection.connectionId, machineId: connection.machineId },
    providerId: connection.source.definition.id,
    sources: connection.source.definition.usageSources ?? [],
    prepareSource: (source: ProviderUsageSourceV1, hasParser: boolean) => prepareSavedUsageSource(input, source, hasParser),
  };
}
