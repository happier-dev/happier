import {
  normalizeProviderEndpointUrlSyntax,
  parseProviderIpAddress,
  type ProviderWireProtocol,
  type QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';
import type {
  ExecRuntimeServiceV1,
  LocalServiceDeclarationV1,
} from '@/plugins/runtime/exec/privateContract';

import type {
  LocalServicesDaemonRuntime,
  TrustedManagedLocalServiceOwnedRun,
} from '@/daemon/local/services/runtime';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type {
  ManagedProviderRuntimeAdapterV1,
  ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';

import {
  startAuthorizedManagedProviderRuntime,
  type ManagedProviderEndpointLaunchFailure,
  type ManagedProviderRuntimePreparation,
} from './managedEndpointLaunch';
import {
  prepareManagedProviderRuntimeAdapter,
  type PreparedManagedProviderRuntimeAdapter,
} from './managedRuntimeAdapterPreparation';
import type { ProviderLaunchResourceScope } from './resourceScope';

type TrustedManagedLocalServices = Pick<
  LocalServicesDaemonRuntime['trustedManagedLocalServices'],
  'startOwned' | 'readOwnedRun' | 'registerOwnedCleanup' | 'stopOwned'
>;

type FirstPartyProviderContribution = Extract<
  ResolvedProviderContribution,
  { provenance: 'first_party' }
>;

export type TransientManagedProviderEndpointResult =
  | Readonly<{
      ok: true;
      normalizedUrl: string;
      downstreamBearer: string;
      run: TrustedManagedLocalServiceOwnedRun;
      isCurrent: () => boolean;
    }>
  | ManagedProviderEndpointLaunchFailure;

function sameFacet(
  left: ResolvedFirstPartyManagedProviderFacet | undefined,
  right: ResolvedFirstPartyManagedProviderFacet,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function isExactAuthorizedPurposeSet(input: Readonly<{
  contribution: FirstPartyProviderContribution;
  facet: ResolvedFirstPartyManagedProviderFacet;
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
}>): boolean {
  if (input.purposes.length === 0) return false;
  const declarationsByPurpose = new Map(
    input.facet.connectedAccounts.map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  if (declarationsByPurpose.size !== input.facet.connectedAccounts.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const purpose of input.purposes) {
    if (
      purpose.consumer.pluginId !== input.contribution.identity.pluginId
      || purpose.consumer.localId !== input.contribution.identity.localId
      || seen.has(purpose.purpose)
      || !declarationsByPurpose.has(purpose.purpose)
    ) {
      return false;
    }
    seen.add(purpose.purpose);
  }
  return input.facet.connectedAccounts.every((declaration) => (
    declaration.required !== true || seen.has(declaration.purpose)
  ));
}

function endpointMatchesOwnedRun(
  normalizedUrl: string,
  run: TrustedManagedLocalServiceOwnedRun,
): boolean {
  if (!run.host || run.port === null) return false;
  const syntax = normalizeProviderEndpointUrlSyntax(normalizedUrl, {
    allowQuery: false,
  });
  const expectedAddress = parseProviderIpAddress(run.host);
  const parsed = new URL(syntax.normalizedUrl);
  const effectivePort = parsed.port.length > 0
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  return expectedAddress?.locality === 'loopback'
    && syntax.literalAddress?.locality === 'loopback'
    && syntax.literalAddress.normalized === expectedAddress.normalized
    && effectivePort === run.port;
}

/**
 * Materializes one credential-free managed endpoint for a bounded daemon
 * operation such as catalog discovery. It deliberately creates no session,
 * Agent binding, or connected-account request-auth capability. Every runtime
 * resource remains in the caller's scope for release after the one probe.
 */
export async function prepareTransientManagedProviderEndpoint(
  input: Readonly<{
    operationId: string;
    contribution: FirstPartyProviderContribution;
    facet: ResolvedFirstPartyManagedProviderFacet;
    runtimeAdapter: ManagedProviderRuntimeAdapterV1;
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    endpointTemplateId: string;
    protocol: ProviderWireProtocol;
    materializationBaseDir: string;
    managedLocalServicesEnabled: boolean;
    isAuthorizationCurrent: () => boolean;
    revalidateBeforeEffect: () => Promise<boolean>;
    localServices: TrustedManagedLocalServices;
    exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
    launchResourceScope: ProviderLaunchResourceScope;
    readinessTimeoutMs?: number;
  }>,
  dependencies: Readonly<{
    resolveRuntimeLaunch?: (
      declaration: ResolvedFirstPartyManagedProviderFacet['managedEndpoint']['localService'],
      preparation: ManagedProviderRuntimePreparation<
        PreparedManagedProviderRuntimeAdapter['prepared']
      >,
    ) => Promise<LocalServiceDeclarationV1 | null>;
  }> = {},
): Promise<TransientManagedProviderEndpointResult> {
  if (
    input.contribution.provenance !== 'first_party'
    || input.contribution.source.kind !== 'bundled'
    || input.contribution.managedRuntimeAdapter !== input.runtimeAdapter
    || !sameFacet(input.contribution.managed, input.facet)
    || !isExactAuthorizedPurposeSet(input)
    || !input.facet.managedEndpoint.protocols.includes(input.protocol)
    || input.operationId.trim().length === 0
  ) {
    return { ok: false, code: 'managed_provider_execution_denied' };
  }

  const started = await startAuthorizedManagedProviderRuntime({
    context: Object.freeze({
      pluginId: input.contribution.identity.pluginId,
      contributionId: input.contribution.identity.localId,
      operationId: input.operationId,
      title: input.contribution.definition.name,
    }),
    declaration: input.facet.managedEndpoint.localService,
    protocols: input.facet.managedEndpoint.protocols,
    purposes: input.purposes,
    managedLocalServicesEnabled: input.managedLocalServicesEnabled,
    isAuthorizationCurrent: input.isAuthorizationCurrent,
    revalidateBeforeEffect: input.revalidateBeforeEffect,
    localServices: input.localServices,
    exec: input.exec,
    launchResourceScope: input.launchResourceScope,
  }, {
    prepareRuntime: async () => await prepareManagedProviderRuntimeAdapter({
      runtimeAdapter: input.runtimeAdapter,
      materializationBaseDir: input.materializationBaseDir,
      purposes: input.purposes,
      protocols: input.facet.managedEndpoint.protocols,
      modelListEnabled: true,
    }),
    ...(dependencies.resolveRuntimeLaunch
      ? { resolveRuntimeLaunch: dependencies.resolveRuntimeLaunch }
      : {}),
    validateReadiness: async ({ preparation, signal }) => (
      await preparation.prepared.readiness.wait(signal)
    ),
    ...(input.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: input.readinessTimeoutMs }),
  });
  if (!started.ok) return started;

  try {
    const normalizedUrl = normalizeProviderEndpointUrlSyntax(
      input.runtimeAdapter.resolveAgentEndpoint({
        host: started.run.host ?? '',
        port: started.run.port ?? 0,
        protocol: input.protocol,
        endpointTemplateId: input.endpointTemplateId,
      }),
      { allowQuery: false },
    ).normalizedUrl;
    if (!endpointMatchesOwnedRun(normalizedUrl, started.run)) {
      return { ok: false, code: 'managed_provider_materialization_failed' };
    }
    return Object.freeze({
      ok: true,
      normalizedUrl,
      downstreamBearer: started.preparation.prepared.downstreamBearer,
      run: started.run,
      isCurrent: started.isCurrent,
    });
  } catch {
    return { ok: false, code: 'managed_provider_materialization_failed' };
  }
}
