import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { BackendTargetKeyV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ProviderBrokerApplicationBindingV1, ProviderBrokerConsumerV1, ProviderBrokerOpenRequestV1, ProviderBrokerOpenResponseV1 } from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  SessionTeamCredentialBindingIntentV1,
  TeamCredentialProviderModelCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { TeamCredentialDirectMaterialPayloadV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialV1';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import {
  materializeLeasedAgentProviderBinding,
  prepareLeasedAgentProviderBinding,
} from '@/plugins/runtime/providerBindings/adapter';
import { isSameTeamCredentialBrokerApplication } from '@/providers/broker/teamCredentialModelCatalog';
import { composeProviderBindingMaterialization } from '@/providers/spawn/compose';
import { resolveProviderCredentialPlaintextAsync } from '@/providers/spawn/credentials';

type BrokerTunnel = Readonly<{
  localPort: number;
  localCapability: string;
  observedPath: 'direct' | 'relay' | 'unknown';
  retire(): Promise<void>;
  close(): Promise<void>;
}>;

export type SessionTeamCredentialProviderBinding = Readonly<{
  providerBinding: AgentSessionProviderBinding;
  environmentOverlay: import('@happier-dev/protocol').SessionEnvOverlayV1;
  additionalRedactionValues: readonly string[];
  cleanup(): Promise<void>;
}>;

export type ExactSessionTeamCredentialProviderSelection = Readonly<{
  resourceId: string;
  brokerMachineId: string;
  expectedResourceRevision: number;
  agentTargetKey: string;
  modelId: string;
  descriptor: TeamCredentialProviderModelCatalogEntryV1['descriptor'];
  application: ProviderBrokerApplicationBindingV1;
  sourceRevision: string;
}>;

type SessionTeamCredentialProviderBindingOpenDependencies = Readonly<{
  sessionId?: string;
  consumer?: ProviderBrokerConsumerV1;
  machineId: string;
  agentId: string;
  lease: PluginRuntimeRegistryLease;
  materializationBaseDir: string;
  signal: AbortSignal;
  openBroker(request: ProviderBrokerOpenRequestV1, signal: AbortSignal): Promise<ProviderBrokerOpenResponseV1>;
  initialBrokerOpen?: Extract<ProviderBrokerOpenResponseV1, { ok: true }>;
  openTunnel(request: Readonly<{
    brokerOpen: Extract<ProviderBrokerOpenResponseV1, { ok: true }>;
    refreshBrokerOpen: (signal?: AbortSignal) => Promise<ProviderBrokerOpenResponseV1>;
    signal?: AbortSignal;
  }>): Promise<BrokerTunnel>;
}>;

type ProviderTeamDirectOpen = NonNullable<
  Parameters<typeof resolveProviderCredentialPlaintextAsync>[0]['openTeamDirect']
>;

export type SessionTeamCredentialDirectOpen = (
  input: Parameters<ProviderTeamDirectOpen>[0] & Readonly<{ consumer: ProviderBrokerConsumerV1 }>,
) => ReturnType<ProviderTeamDirectOpen>;

function resolveProviderBrokerConsumer(input: Readonly<{
  sessionId?: string;
  consumer?: ProviderBrokerConsumerV1;
}>): ProviderBrokerConsumerV1 {
  const sessionId = input.sessionId?.trim();
  if (input.consumer?.kind === 'execution_run') {
    const executionRunId = input.consumer.executionRunId.trim();
    if (!executionRunId) throw new Error('team_credential_provider_selection_not_current');
    return { kind: 'execution_run', executionRunId };
  }
  if (input.consumer?.kind === 'session') {
    const consumerSessionId = input.consumer.sessionId.trim();
    if (!consumerSessionId || (sessionId && consumerSessionId !== sessionId)) {
      throw new Error('team_credential_provider_selection_not_current');
    }
    return { kind: 'session', sessionId: consumerSessionId };
  }
  if (!sessionId) {
    throw new Error('team_credential_provider_selection_not_current');
  }
  return { kind: 'session', sessionId };
}

function assertExactSelectionIsCoherent(input: Readonly<{
  selection: ExactSessionTeamCredentialProviderSelection;
  agentId: string;
  lease: PluginRuntimeRegistryLease;
}>): void {
  const { selection } = input;
  const target = BackendTargetKeyV2Schema.safeParse(selection.agentTargetKey);
  const declaredAgent = input.lease.registry.contributes.agentDefinitionsById.get(input.agentId);
  const runtimeAgent = input.lease.registry.agentRuntimesByAgentId.get(input.agentId);
  const targetMatchesAgent = target.success
    ? (() => {
        const parsed = parseBackendTargetKeyV2(target.data);
        if (parsed.kind === 'backend') return parsed.backendId === input.agentId;
        if (!declaredAgent?.identity || !runtimeAgent) return false;
        return declaredAgent.identity.pluginId === parsed.identity.pluginId
          && declaredAgent.identity.localId === parsed.identity.localId
          && runtimeAgent.pluginId === parsed.identity.pluginId;
      })()
    : selection.agentTargetKey === `backend:${input.agentId}:built_in`;
  if (
    selection.resourceId.length === 0
    || selection.brokerMachineId.length === 0
    || !Number.isSafeInteger(selection.expectedResourceRevision)
    || selection.expectedResourceRevision < 0
    || selection.sourceRevision.length === 0
    || selection.modelId !== selection.descriptor.id
    || selection.agentTargetKey !== selection.application.agentTargetKey
    || !targetMatchesAgent
  ) {
    throw new Error('team_credential_provider_selection_invalid');
  }
}

/**
 * Opens one exact, already-authoritative Team credential selection. The caller
 * owns selection/currentness; this owner performs no catalog discovery or
 * replacement selection and only composes the canonical broker/materializer.
 */
export async function openExactSessionTeamCredentialProviderBinding(
  input: SessionTeamCredentialProviderBindingOpenDependencies & Readonly<{
    selection: ExactSessionTeamCredentialProviderSelection;
    revalidateSelection?(input: Readonly<{
      signal: AbortSignal;
      brokerOpen: Extract<ProviderBrokerOpenResponseV1, { ok: true }>;
      tunnel: BrokerTunnel;
    }>): Promise<void>;
  }>,
): Promise<SessionTeamCredentialProviderBinding> {
  input.signal.throwIfAborted();
  assertExactSelectionIsCoherent(input);
  const selection = input.selection;
  const consumer = resolveProviderBrokerConsumer(input);
  const materializationScopeId = consumer.kind === 'execution_run'
    ? consumer.executionRunId
    : consumer.sessionId;

  const brokerOpenRequest = {
    v: 1,
    resourceId: selection.resourceId,
    expectedResourceRevision: selection.expectedResourceRevision,
    modelId: selection.modelId,
    sourceRevision: selection.sourceRevision,
    initiatorMachineId: input.machineId,
    consumer,
    application: selection.application,
  } as const;
  const opened = input.initialBrokerOpen ?? await input.openBroker(brokerOpenRequest, input.signal);
  if (!opened.ok) throw new Error(opened.reasonCode);
  const authority = opened.authority.payload;
  if (
    opened.target.brokerMachineId !== selection.brokerMachineId
    || authority.target.machineId !== selection.brokerMachineId
  ) {
    throw new Error('team_credential_provider_broker_machine_changed');
  }
  if (
    authority.resourceId !== selection.resourceId
    || authority.sourceRevision !== selection.sourceRevision
    || !isDeepStrictEqual(authority.application, selection.application)
  ) {
    throw new Error('team_credential_provider_selection_changed');
  }
  if (
    authority.initiator.machineId !== input.machineId
    || !isDeepStrictEqual(authority.consumer, consumer)
    || authority.target.custodianAccountId !== opened.target.custodianAccountId
    || authority.target.endpointId !== opened.target.endpointId
  ) {
    throw new Error('team_credential_provider_broker_open_changed');
  }
  input.signal.throwIfAborted();
  const tunnel = await input.openTunnel({
    brokerOpen: opened,
    // An established tunnel renews by presenting the prior signed authority it
    // already holds. How the Home first selected this exact target is not a
    // runtime renewal policy, so every established open refreshes the same way.
    refreshBrokerOpen: async (signal = input.signal) => await input.openBroker({
      ...brokerOpenRequest,
      refreshAuthority: opened.authority,
    }, signal),
    signal: input.signal,
  });
  let composed: Awaited<ReturnType<typeof composeProviderBindingMaterialization>> | null = null;
  try {
    input.signal.throwIfAborted();
    await input.revalidateSelection?.({ signal: input.signal, brokerOpen: opened, tunnel });
    input.signal.throwIfAborted();

    const bindingKey = `team_resource:${selection.resourceId}:revision:${selection.expectedResourceRevision}:route:brokered`;
    const prepared = prepareLeasedAgentProviderBinding({
      lease: input.lease,
      agentId: input.agentId,
      input: { v: 1, agentTargetKey: selection.agentTargetKey, bindingKey },
    });
    // The Agent receives only its scoped loopback endpoint and the tunnel's
    // local capability as its bearer. The Home-signed cross-Account authority
    // was admitted by the trusted transport owner during the machine/1
    // handshake and never enters Agent configuration, environment or requests.
    const credentialTransport = {
      id: 'team-provider-broker-local-capability-v1',
      protocols: [selection.application.protocol],
      uses: ['runtime'] as const,
      destination: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
    };
    const materialization = await materializeLeasedAgentProviderBinding({
      lease: input.lease,
      agentId: input.agentId,
      binding: {
        v: 1,
        agentTargetKey: selection.agentTargetKey,
        selection: { bindingKey, model: selection.descriptor },
        contributionKey: null,
        endpoint: {
          endpointTemplateId: selection.application.endpointTemplateId,
          normalizedUrl: `http://127.0.0.1:${tunnel.localPort}/v1`,
          protocol: selection.application.protocol,
          publicHeaders: {
            'X-Happier-Machine-Local-Capability': tunnel.localCapability,
          },
        },
        runtimeCredentialTransport: credentialTransport,
        compatibilityFingerprint: selection.sourceRevision,
      },
      prepared,
      credential: {
        kind: 'apiKey',
        transport: credentialTransport,
        value: tunnel.localCapability,
      },
    });
    composed = await composeProviderBindingMaterialization({
      materialization,
      materializationBaseDir: join(input.materializationBaseDir, 'team-broker'),
      sessionId: materializationScopeId,
    });
    const retainedCleanup = composed.takeCleanupOwnership();
    let closed = false;
    let materializationReleased = false;
    let cleanupInFlight: Promise<void> | null = null;
    return Object.freeze({
      providerBinding: {
        source: {
          kind: 'team_resource',
          resourceId: selection.resourceId,
          resourceRevision: selection.expectedResourceRevision,
        },
        model: selection.descriptor,
        upstream: {
          protocol: selection.application.protocol,
          normalizedUrl: `http://127.0.0.1:${tunnel.localPort}/v1`,
          credential: 'apiKey',
        },
        materialization: composed.launchMaterialization,
      },
      environmentOverlay: composed.providerEnvironmentOverlay,
      // The one-shot local capability is the Agent's bearer and also travels in
      // the endpoint's public headers, so it is redacted from transcripts and
      // logs exactly like a direct source credential.
      additionalRedactionValues: Object.freeze([
        tunnel.localCapability,
        ...composed.additionalRedactionValues,
      ]),
      cleanup() {
        if (closed) return Promise.resolve();
        cleanupInFlight ??= (async () => {
          try {
            if (!materializationReleased) {
              retainedCleanup?.();
              materializationReleased = true;
            }
          } finally {
            // The retirement DELETE travels over this tunnel, so the transport
            // outlives the attempt: closing it on a failed retirement destroys
            // the only way to reach the target and strands the operation it
            // still holds. A failure leaves `closed` false, so the caller's
            // next cleanup retries over the same transport.
            await tunnel.retire();
            await tunnel.close();
          }
        })().then(
          () => {
            closed = true;
            cleanupInFlight = null;
          },
          (error: unknown) => {
            cleanupInFlight = null;
            throw error;
          },
        );
        return cleanupInFlight;
      },
    });
  } catch (error) {
    composed?.cleanup?.();
    await tunnel.retire().catch(() => undefined);
    await tunnel.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Opens the one Session-lived worker side of a Team credential broker binding.
 * Home remains the selection/currentness owner, the machine carrier owns the
 * tunnel, and the existing Agent adapter remains the sole materializer.
 */
export async function openSessionTeamCredentialProviderBinding(input: Readonly<{
  sessionId?: string;
  consumer?: ProviderBrokerConsumerV1;
  machineId: string;
  agentId: string;
  agentTargetKey: string;
  modelId: string;
  binding: SessionTeamCredentialBindingIntentV1;
  lease: PluginRuntimeRegistryLease;
  materializationBaseDir: string;
  signal: AbortSignal;
  readCatalog(signal: AbortSignal): Promise<readonly TeamCredentialProviderModelCatalogEntryV1[]>;
  openBroker?: SessionTeamCredentialProviderBindingOpenDependencies['openBroker'];
  openTunnel?: SessionTeamCredentialProviderBindingOpenDependencies['openTunnel'];
  openTeamDirect?: SessionTeamCredentialDirectOpen;
}>): Promise<SessionTeamCredentialProviderBinding | null> {
  if (input.binding.slot.kind !== 'provider_model' || input.binding.resourceId === null) return null;
  const consumer = resolveProviderBrokerConsumer(input);
  const materializationScopeId = consumer.kind === 'execution_run'
    ? consumer.executionRunId
    : consumer.sessionId;
  input.signal.throwIfAborted();
  const rows = await input.readCatalog(input.signal);
  // The selection's revision was the precondition of the selection mutation,
  // not the binding's identity: a policy edit since then must not strand a
  // fresh open. The catalog owner reports the current revision, the open binds
  // it, and the Home rechecks it (`04-private-iroh-broker-transport.md:272`,
  // 10.11 A2(3)-(4)).
  const row = rows.find((candidate) => (
    candidate.selection.resourceId === input.binding.resourceId
    && candidate.selection.deliveryMode === input.binding.deliveryMode
    && candidate.selection.agentTargetKey === input.agentTargetKey
    && candidate.selection.modelId === input.modelId
    && candidate.availability === 'available'
  ));
  if (!row) throw new Error('team_credential_provider_selection_not_current');

  if (input.binding.deliveryMode === 'direct') {
    if (!row.direct) {
      throw new Error('team_credential_direct_material_not_current');
    }
    if (!input.openTeamDirect) throw new Error('team_credential_direct_material_unavailable');
    const direct = row.direct;
    let openedDirectPayload: unknown;
    const resolved = await resolveProviderCredentialPlaintextAsync({
      reference: {
        kind: 'team_direct',
        teamId: row.selection.teamId,
        resourceId: row.selection.resourceId,
        expectedResourceRevision: row.selection.expectedResourceRevision,
        sourceMemberKey: direct.sourceMemberKey,
        sourceVersion: direct.sourceVersion,
      },
      accountSettings: {},
      settingsSecretsReadKeys: [],
      connectionId: row.selection.resourceId,
      machineId: input.machineId,
      openTeamDirect: async (request) => {
        const opened = await input.openTeamDirect!({ ...request, consumer });
        if (opened.ok) openedDirectPayload = opened.payload;
        return opened;
      },
    });
    if (!resolved.ok) throw resolved.error;
    if (resolved.credential.kind !== 'apiKey') throw new Error('team_credential_direct_material_invalid');
    const privatePayload = TeamCredentialDirectMaterialPayloadV1Schema.safeParse(openedDirectPayload);
    if (!privatePayload.success || privatePayload.data.material.kind !== 'provider_api_key') {
      throw new Error('team_credential_direct_material_invalid');
    }
    const runtimeBinding = privatePayload.data.material.runtimeBinding;
    if (
      runtimeBinding.provider.identity.pluginId !== row.application.implementationIdentity.pluginId
      || runtimeBinding.provider.identity.localId !== row.application.implementationIdentity.localId
      || runtimeBinding.endpoint.endpointTemplateId !== row.application.endpointTemplateId
      || runtimeBinding.endpoint.protocol !== row.application.protocol
    ) {
      throw new Error('team_credential_provider_selection_changed');
    }

    // Re-read after disclosure so a revoke/rotation racing the open cannot be
    // admitted into a new Session. Already-running providers remain subject to
    // the product's explicit copied-material disclosure contract.
    const currentRows = await input.readCatalog(input.signal);
    const current = currentRows.find((candidate) => (
      candidate.selection.resourceId === row.selection.resourceId
      && candidate.selection.expectedResourceRevision === row.selection.expectedResourceRevision
      && candidate.selection.deliveryMode === row.selection.deliveryMode
      && candidate.selection.agentTargetKey === row.selection.agentTargetKey
      && candidate.selection.modelId === row.selection.modelId
      && candidate.sourceRevision === row.sourceRevision
      && candidate.availability === 'available'
      && isDeepStrictEqual(candidate.descriptor, row.descriptor)
      && isSameTeamCredentialBrokerApplication(candidate.application, row.application)
      && isDeepStrictEqual(candidate.direct, direct)
    ));
    if (!current) throw new Error('team_credential_provider_selection_changed');

    const bindingKey = `team_resource:${row.selection.resourceId}:revision:${row.selection.expectedResourceRevision}:route:direct`;
    const prepared = prepareLeasedAgentProviderBinding({
      lease: input.lease,
      agentId: input.agentId,
      input: { v: 1, agentTargetKey: row.selection.agentTargetKey, bindingKey },
    });
    const materialization = await materializeLeasedAgentProviderBinding({
      lease: input.lease,
      agentId: input.agentId,
      binding: {
        v: 1,
        agentTargetKey: row.selection.agentTargetKey,
        selection: { bindingKey, model: row.descriptor },
        contributionKey: null,
        endpoint: runtimeBinding.endpoint,
        runtimeCredentialTransport: runtimeBinding.credentialTransport,
        compatibilityFingerprint: row.sourceRevision,
      },
      prepared,
      credential: {
        kind: 'apiKey',
        transport: runtimeBinding.credentialTransport,
        value: resolved.credential.value,
      },
    });
    const composed = await composeProviderBindingMaterialization({
      materialization,
      materializationBaseDir: join(input.materializationBaseDir, 'team-direct'),
      sessionId: materializationScopeId,
    });
    const retainedCleanup = composed.takeCleanupOwnership();
    let closed = false;
    return Object.freeze({
      providerBinding: {
        source: {
          kind: 'team_resource',
          resourceId: row.selection.resourceId,
          resourceRevision: row.selection.expectedResourceRevision,
        },
        model: row.descriptor,
        upstream: {
          protocol: runtimeBinding.endpoint.protocol,
          normalizedUrl: runtimeBinding.endpoint.normalizedUrl,
          credential: 'apiKey',
        },
        materialization: composed.launchMaterialization,
      },
      environmentOverlay: composed.providerEnvironmentOverlay,
      additionalRedactionValues: Object.freeze([
        resolved.credential.value,
        ...composed.additionalRedactionValues,
      ]),
      async cleanup() {
        if (closed) return;
        closed = true;
        retainedCleanup?.();
      },
    });
  }

  if (!input.openBroker || !input.openTunnel) throw new Error('team_credential_provider_broker_unavailable');
  const opened = await input.openBroker({
    v: 1,
    resourceId: row.selection.resourceId,
    expectedResourceRevision: row.selection.expectedResourceRevision,
    modelId: row.selection.modelId,
    sourceRevision: row.sourceRevision,
    initiatorMachineId: input.machineId,
    consumer,
    application: row.application,
  }, input.signal);
  if (!opened.ok) throw new Error(opened.reasonCode);

  return await openExactSessionTeamCredentialProviderBinding({
    consumer,
    machineId: input.machineId,
    agentId: input.agentId,
    selection: {
      resourceId: row.selection.resourceId,
      brokerMachineId: opened.target.brokerMachineId,
      expectedResourceRevision: row.selection.expectedResourceRevision,
      agentTargetKey: row.selection.agentTargetKey,
      modelId: row.selection.modelId,
      descriptor: row.descriptor,
      application: row.application,
      sourceRevision: row.sourceRevision,
    },
    lease: input.lease,
    materializationBaseDir: input.materializationBaseDir,
    signal: input.signal,
    openBroker: input.openBroker,
    initialBrokerOpen: opened,
    openTunnel: input.openTunnel,
    revalidateSelection: async ({ signal }) => {
      const currentRows = await input.readCatalog(signal);
      const current = currentRows.find((candidate) => (
        candidate.selection.resourceId === row.selection.resourceId
        && candidate.selection.expectedResourceRevision === row.selection.expectedResourceRevision
        && candidate.selection.deliveryMode === row.selection.deliveryMode
        && candidate.selection.agentTargetKey === row.selection.agentTargetKey
        && candidate.selection.modelId === row.selection.modelId
        && candidate.sourceRevision === row.sourceRevision
        && candidate.availability === 'available'
        && isDeepStrictEqual(candidate.descriptor, row.descriptor)
        && isSameTeamCredentialBrokerApplication(candidate.application, row.application)
      ));
      if (!current) throw new Error('team_credential_provider_selection_changed');
    },
  });
}
