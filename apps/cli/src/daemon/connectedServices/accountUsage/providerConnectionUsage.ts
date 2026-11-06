import { buildProviderAccountUsageOpaqueLocalCredentialRef, buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { createProviderUsageRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { resolveProviderSecretBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderSettingsV1 } from '@happier-dev/protocol';
import type { DaemonProviderUsageRefreshResponseV1, ProviderUsageSourceResultV1 } from '@happier-dev/protocol/rpc/providers';
import type { ProviderUsageParser } from '@happier-dev/plugin-sdk/providers';

import type { ResolvedProviderConnectionRecord } from '@/providers/registry';
import type { ProviderProbeAuthorizationPort, ProviderProbeAuthorizationRequest, ProviderProbeOperationScope } from '@/providers/probe/authorization';
import { ProviderProbeCredentialResolutionError, ProviderProbeDestinationAuthorizationError } from '@/providers/probe/authorization';
import { ProviderProbeClientError, ProviderProbeCancelledError, type createProviderProbeHttpClient } from '@/providers/probe/client';
import { ProviderOperationAbandonedError } from '@/providers/operationLifetime';

export type ProviderUsageParserBinding = Readonly<{
  activationOccurrenceId: string;
  parsersByFormat: Readonly<Record<string, ProviderUsageParser>>;
  isCurrent(): boolean;
}>;

/** Explicit Provider acquisition adapter for the existing Q1 snapshot owner.
 * No ledger, timer or shared Account identity is inferred from a connection key.
 */
export async function refreshProviderConnectionUsage<TTicket, TCredentialRef>(input: Readonly<{
  connection: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
  parsers: ProviderUsageParserBinding;
  client: Pick<ReturnType<typeof createProviderProbeHttpClient>, 'getUsage'>;
  authorization: ProviderProbeAuthorizationPort<TTicket, TCredentialRef>;
  admitSource(sourceId: string): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: Extract<ProviderUsageSourceResultV1, { status: 'error' }>['error'] }>>;
  operationScope: ProviderProbeOperationScope;
  staleAfterMs: number;
  now?: () => number;
}>): Promise<DaemonProviderUsageRefreshResponseV1> {
  const connection = input.connection;
  if (connection.source.kind !== 'contribution' || connection.deployment.kind !== 'external') return { status: 'not_supported' };
  const sources = connection.source.definition.usageSources ?? [];
  if (sources.length === 0) return { status: 'not_supported' };
  const identity = { connectionId: connection.connectionId, machineId: connection.machineId };
  const results: ProviderUsageSourceResultV1[] = [];
  const now = input.now ?? Date.now;
  const unavailable = () => createProviderErrorV1('provider_contribution_unavailable', identity);
  for (const source of sources) {
    const fail = (error: Extract<ProviderUsageSourceResultV1, { status: 'error' }>['error']) =>
      results.push({ sourceId: source.id, status: 'error', error });
    // No binding means no billing request, not a failed account-credit meter or
    // permission to reuse the inference key for a management endpoint.
    if (source.billingCredential && resolveProviderSecretBindingIdV1(input.providerSettings,
      connection.connectionId, connection.machineId, source.billingCredential.slotId) === null) {
      results.push({ sourceId: source.id, status: 'not_configured' });
      continue;
    }
    const parse = input.parsers.parsersByFormat[source.parser];
    const endpoint = connection.endpoints.find(endpoint => endpoint.endpointTemplateId === source.endpointTemplateId);
    if (!parse || !endpoint) { fail(unavailable()); continue; }
    const request: ProviderProbeAuthorizationRequest = {
      purpose: 'usage', usageSourceId: source.id, ...identity,
      endpointTemplateId: endpoint.endpointTemplateId, endpointUrl: endpoint.normalizedUrl,
      protocol: endpoint.protocol, path: source.path, parser: source.parser,
      probeRequestFingerprint: createProviderUsageRequestFingerprintV1({
        endpointUrl: endpoint.normalizedUrl, source, publicHeaders: endpoint.publicHeaders,
      }),
    };
    try {
      const admission = await input.admitSource(source.id);
      if (!admission.ok) { fail(admission.error); continue; }
      const authorization = await input.authorization.authorize(request, input.operationScope);
      if (!authorization.ok) { fail(authorization.error); continue; }
      const credentialRef = authorization.credentialRef;
      const result = await input.client.getUsage({
        endpointUrl: endpoint.normalizedUrl, path: source.path, publicHeaders: endpoint.publicHeaders,
        credentialPolicy: source.billingCredential || connection.source.definition.credential?.required ? 'required' : 'optional',
        parse,
        authorizeDestination: async destination => {
          const validation = await input.authorization.authorizeDestination(authorization.ticket, request, destination, input.operationScope);
          if (!validation.ok) throw new ProviderProbeDestinationAuthorizationError(validation.error);
        },
        ...(credentialRef === null ? {} : { resolveCredential: async () => {
          const resolution = await input.authorization.resolveCredential(credentialRef, input.operationScope);
          if (!resolution.ok) throw new ProviderProbeCredentialResolutionError(resolution.error);
          return resolution.lease;
        } }),
        signal: input.operationScope.lifetime.signal,
        wallDeadlineAtMs: input.operationScope.lifetime.wallDeadlineAtMs,
      });
      const providerId = connection.source.definition.id;
      const accountSubjectId = buildProviderAccountUsageOpaqueLocalCredentialRef({
        providerId, kind: 'connection-usage', value: JSON.stringify({
          contributionKey: connection.source.contributionKey, ...identity, sourceId: source.id,
          authorization: authorization.observationAuthorizationFingerprint,
        }),
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
