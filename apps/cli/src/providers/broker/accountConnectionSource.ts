import { isDeepStrictEqual } from 'node:util';
import { pluginJsonValuesEqual } from '@happier-dev/protocol';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import type { SignedProviderBrokerRouteGrantV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveManagedProviderPurposeBindingSnapshot, type ResolveManagedProviderPurposeBindingIntent } from '@/providers/managed/resolvePurposeBindingSnapshot';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import type { ProviderConnectionRegistryReader } from './providerConnectionSource';
import { createAccountConnectionModelProjectionRequest, projectProviderBrokerApplication } from './applicationProjection';
import { acquireBrokerSourceOperation } from './brokerSourceOperationAcquisition';
import type { ProviderBrokerAccountConnectionAccess } from './daemonProviderBrokerRuntime';

/** An ended consumer releases only the custody already named by its signed
 * source. No catalog refresh, secret resolution or new acquisition occurs. */
export async function retireAccountConnectionBrokerSource(input: Readonly<{
  homeId: string; accountId: string; machineId: string; custody: ManagedProviderExplicitStartCustody;
  authority: SignedProviderBrokerRouteGrantV2;
}>): Promise<void> {
  const payload = input.authority.payload;
  if (payload.homeId !== input.homeId || payload.accountId !== input.accountId || payload.target.machineId !== input.machineId) return;
  await input.custody.retire({ identity: payload.application.implementationIdentity,
    operationClaim: { kind: 'providerBroker', operation: payload.consumer },
    sharedGateway: { homeId: input.homeId, accountId: input.accountId, machineId: input.machineId,
      connectionId: payload.source.connectionId, consumerId: JSON.stringify(payload.consumer) },
  });
}

/** Personal and Team sources share catalog projection and managed custody.
 * Only the source-specific authority differs; this adapter never reads Team
 * policy, selects a Pool member or obtains credential plaintext. */
export type AccountConnectionManagedConsumerRequest = Readonly<{
  source: SignedProviderBrokerRouteGrantV2['payload']['source'];
  application: SignedProviderBrokerRouteGrantV2['payload']['application'];
  consumer: SignedProviderBrokerRouteGrantV2['payload']['consumer'];
  executionRunOccurrenceId?: string;
  consumerMachineId: string;
}>;

type AccountConnectionManagedConsumerSourceInput = Readonly<{
  homeId: string;
  accountId: string;
  machineId: string;
  expectedAccountSettingsScopeKey: string;
  custody: ManagedProviderExplicitStartCustody;
  withRegistry: ProviderConnectionRegistryReader;
  getAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null;
  resolveBindingIntent: ResolveManagedProviderPurposeBindingIntent;
  projectModels(request: DaemonProviderModelProjectionRequestV1): Promise<DaemonProviderModelProjectionResponseV1>;
  admitConsumer(request: AccountConnectionManagedConsumerRequest, signal?: AbortSignal): Promise<boolean>;
}>;

/** The signed carrier and trusted local Run adapter supply different consumer
 * witnesses. Private source/purpose admission and physical custody have one
 * owner; neither adapter supplies catalog or credential truth. */
export function createAccountConnectionManagedConsumerSourceOpen(input: AccountConnectionManagedConsumerSourceInput):
  (request: AccountConnectionManagedConsumerRequest & Readonly<{ signal: AbortSignal }>) => Promise<ProviderBrokerAccountConnectionAccess | null> {
  return async ({ signal, ...payload }) => {
    const captured = input.getAccountSettingsSnapshot();
    if (!captured?.scopeKey || captured.scopeKey !== input.expectedAccountSettingsScopeKey
      || !await input.admitConsumer(payload, signal)) return null;
    const scopeKey = captured.scopeKey;
    const catalog = captured.providerConnectionsCatalog?.status === 'ready'
      ? captured.providerConnectionsCatalog : await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: scopeKey });
    if (catalog.status !== 'ready') return null;
    const readSource = async () => await input.withRegistry(async registry => {
      const snapshot = input.getAccountSettingsSnapshot();
      if (!snapshot || snapshot.scopeKey !== scopeKey || snapshot.scopeKey !== input.expectedAccountSettingsScopeKey
        || snapshot.providerConnectionsCatalog?.status !== 'ready') return null;
      const resolved = resolveProviderConnectionForMachine({
        connectionId: payload.source.connectionId, machineId: input.machineId,
        providerSettings: readProviderSettingsForCli(snapshot).settings, registry, dnsEvidenceByEndpointUrl: new Map(),
      });
      if (resolved.status !== 'resolved') return null;
      const record = resolved.record;
      const targetMachineId = record.connection.gatewayPlacement?.kind === 'machine'
        ? record.connection.gatewayPlacement.machineId : payload.consumerMachineId;
      if (!record.authorization.authorized || record.deployment.kind !== 'managedLocal'
        || record.connectionSecurityFingerprint !== payload.source.expectedConnectionSecurityFingerprint
        || record.deployment.managedRuntime.sharing !== 'connectionMachine'
        || record.source.kind !== 'contribution' || targetMachineId !== input.machineId) return null;
      const application = projectProviderBrokerApplication({ connection: record, agentTargetKey: payload.application.agentTargetKey,
        protocol: payload.application.protocol, expectedApplication: payload.application });
      if (!application || !pluginJsonValuesEqual(application, payload.application)) return null;
      const purposeBindings = await resolveManagedProviderPurposeBindingSnapshot({
        implementationIdentity: record.deployment.implementationIdentity,
        connectedAccounts: record.deployment.managedRuntime.connectedAccounts,
        purposeBindingIntents: record.deployment.purposeBindingIntents, resolveBindingIntent: input.resolveBindingIntent,
      });
      const purposeBasis = createProviderManagedRuntimeBindingFingerprintV1({
        implementationIdentity: record.deployment.implementationIdentity,
        managedRuntime: record.deployment.managedRuntime, purposeBindings,
      });
      if (purposeBasis !== payload.source.expectedManagedRuntimeBindingFingerprint) return null;
      return {
        identity: record.deployment.implementationIdentity,
        contributionKey: record.source.contributionKey,
        securityFingerprint: record.connectionSecurityFingerprint,
        grantFingerprint: record.authorization.grantFingerprint,
        purposeBindings,
        purposeBasis,
      };
    });
    const source = await readSource();
    if (!source) return null;
    // The source projection opens the hub's current Account catalog. An opaque
    // connection id or a transport grant cannot supply model/protocol facts.
    const projection = await input.projectModels(createAccountConnectionModelProjectionRequest({
      machineId: input.machineId, agentTargetKey: payload.application.agentTargetKey,
      application: payload.application, refreshPolicy: 'current_only',
      connectionId: payload.source.connectionId, expectedConnectionSecurityFingerprint: source.securityFingerprint,
    }));
    if (projection.status !== 'success' || projection.agentTargetKey !== payload.application.agentTargetKey
      || !projection.groups.some(group => group.connectionId === payload.source.connectionId
      && group.authorization.authorized
      && group.sourceAuthority?.connectionSecurityFingerprint === source.securityFingerprint
      && pluginJsonValuesEqual(group.sourceAuthority.provider.identity, source.identity)
      && group.rows.some(row => row.compatibility.result.status !== 'incompatible'
        && !row.catalog.stale && row.application !== undefined
        && pluginJsonValuesEqual(row.application, payload.application)))) return null;
    const isSourceCurrent = async (currentSignal: AbortSignal): Promise<boolean> => {
      currentSignal.throwIfAborted();
      if (!await input.admitConsumer(payload, currentSignal)) return false;
      const current = await readSource();
      return current !== null && current.securityFingerprint === source.securityFingerprint
        && current.grantFingerprint === source.grantFingerprint && current.purposeBasis === source.purposeBasis
        && isDeepStrictEqual(current.identity, source.identity);
    };
    const opened = await acquireBrokerSourceOperation({
      custody: input.custody, identity: source.identity, contributionKey: source.contributionKey,
      endpointTemplateId: payload.application.endpointTemplateId, purposeBindings: source.purposeBindings,
      operationClaim: { kind: 'providerBroker', operation: payload.consumer },
      sharedGateway: { homeId: input.homeId, accountId: input.accountId, connectionId: payload.source.connectionId,
        machineId: input.machineId, consumerId: JSON.stringify(payload.consumer) },
      isSourceCurrent, revalidateOperationAuthorization: async currentSignal => await input.admitConsumer(payload, currentSignal),
      callerSignal: signal,
    });
    if (!opened) return null;
    return {
      access: opened.projection.access,
      revalidate: opened.revalidateAuthorization,
      cleanup: async () => await opened.projection.cleanup(),
      retire: async () => { await opened.retire(); await opened.projection.cleanup(); },
    };
  };
}

export function createAccountConnectionBrokerSourceOpen(input: Omit<AccountConnectionManagedConsumerSourceInput, 'admitConsumer'> & Readonly<{
  admitConsumer(authority: SignedProviderBrokerRouteGrantV2, signal?: AbortSignal): Promise<boolean>;
}>): (request: Readonly<{ authority: SignedProviderBrokerRouteGrantV2; signal: AbortSignal }>) => Promise<ProviderBrokerAccountConnectionAccess | null> {
  return async ({ authority, signal }) => {
    const payload = authority.payload;
    if (payload.homeId !== input.homeId || payload.accountId !== input.accountId || payload.target.machineId !== input.machineId) return null;
    return await createAccountConnectionManagedConsumerSourceOpen({ ...input,
      admitConsumer: async (_request, currentSignal) => await input.admitConsumer(authority, currentSignal),
    })({ source: payload.source, application: payload.application, consumer: payload.consumer,
      ...(payload.executionRunOccurrenceId ? { executionRunOccurrenceId: payload.executionRunOccurrenceId } : {}),
      consumerMachineId: payload.initiator.machineId, signal });
  };
}
