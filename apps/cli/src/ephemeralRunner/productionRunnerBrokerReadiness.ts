import { isDeepStrictEqual } from 'node:util';

import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { RunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import type { RunnerLaunchManifestV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import { signRunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import type { RunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import { signRunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol/ephemeralRunner/brokerReadinessRequestV1';
import type { RunnerBrokerReadinessProjectionV1 } from '@happier-dev/protocol/teams';

import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';

import { checkRunnerBrokerNonInferenceReadiness } from './runnerBrokerReadinessClient';
import { resolveReviewedRunnerBrokerApplicationCompatibility } from './runnerBrokerReadinessProtocol';
import type { ReviewedRunnerPluginRuntimeHandle } from './runnerPluginRuntimeLease';

type ProductionReadinessPreparation = Readonly<{
  managed: Readonly<{ resolution: Readonly<{ command: string }> }>;
  pluginRuntime: ReviewedRunnerPluginRuntimeHandle;
}>;

export async function checkProductionRunnerBrokerReadiness(input: Readonly<{
  binding: RunnerActivationBindingV1;
  claim: RunnerClaimV1;
  manifest: RunnerLaunchManifestV1;
  launchManifestCommitment: string;
  activationSecretKey: Uint8Array;
  installationSecretKey: Uint8Array;
  preparation: ProductionReadinessPreparation;
  projection: RunnerBrokerReadinessProjectionV1;
  happyHomeDir: string;
  signal: AbortSignal;
  transportCheck?: typeof checkRunnerBrokerNonInferenceReadiness;
}>): Promise<
  | Readonly<{ status: 'ready'; readiness: RunnerReadinessV1 }>
  | Readonly<{ status: 'denied' | 'unavailable'; reason: string }>
> {
  input.signal.throwIfAborted();
  const selection = input.manifest.credentialSelectionBinding;
  if (!isDeepStrictEqual(selection, input.projection.credentialSelectionBinding)) {
    return { status: 'denied', reason: 'credential_selection_changed' };
  }
  if (input.projection.readiness.kind !== 'available') {
    return {
      status: input.projection.readiness.kind === 'broker_unavailable' ? 'unavailable' : 'denied',
      reason: input.projection.readiness.kind,
    };
  }
  const providerProjection = input.projection.provider;
  if (!providerProjection) return { status: 'unavailable', reason: 'provider_projection_unavailable' };
  const target = input.manifest.preparedAuthoring.authoring.agentTarget;
  if (!target || target.kind !== 'agent') return { status: 'denied', reason: 'reviewed_agent_target_unavailable' };
  if (
    target.identity.pluginId !== input.preparation.pluginRuntime.selected.pluginId
    || target.identity.localId !== input.preparation.pluginRuntime.selected.localId
  ) {
    return { status: 'denied', reason: 'reviewed_agent_target_changed' };
  }
  const agentTargetKey = buildBackendTargetKeyV2(target);
  const agent = readLeasedAgentProviderRequirements({
    lease: input.preparation.pluginRuntime.lease,
    agentId: input.preparation.pluginRuntime.selected.agentId,
  });
  if (!agent) return { status: 'unavailable', reason: 'agent_provider_requirements_unavailable' };
  const providerKey = buildQualifiedPluginContributionKey(providerProjection.identity);
  const provider = input.preparation.pluginRuntime.lease.registry.contributes.providersByContributionKey?.get(providerKey);
  if (
    !provider
    || !isDeepStrictEqual(provider.identity, providerProjection.identity)
    || provider.definition.v !== providerProjection.definitionRevision
  ) return { status: 'unavailable', reason: 'provider_definition_changed' };
  if (!isDeepStrictEqual(selection.application.implementationIdentity, providerProjection.identity)) {
    return { status: 'unavailable', reason: 'reviewed_application_changed' };
  }
  const compatibility = resolveReviewedRunnerBrokerApplicationCompatibility({
    agentTargetKey,
    agent,
    endpoints: provider.definition.endpointTemplates,
    application: selection.application,
    ...(provider.definition.credential ? { credential: provider.definition.credential } : {}),
  });
  if (compatibility.status !== 'ready') return { status: 'unavailable', reason: compatibility.reason };

  const transportCheck = input.transportCheck ?? checkRunnerBrokerNonInferenceReadiness;
  let brokerReadinessRequest: ReturnType<typeof signRunnerBrokerReadinessRequestV1> | null = null;
  const readiness = await transportCheck({
    createRequest: (initiatorEndpointId) => {
      brokerReadinessRequest = signRunnerBrokerReadinessRequestV1({
        facts: {
          v: 1,
          kind: 'provider_broker_readiness',
          homeServerIdentityId: input.binding.homeServerIdentityId,
          activationId: input.binding.activationId,
          launchManifestCommitment: input.launchManifestCommitment,
          resourceId: selection.resourceId,
          agentTargetKey,
          protocol: selection.application.protocol,
          modelId: input.manifest.reviewedProviderModel.selection.modelId,
          initiator: {
            installationId: input.claim.payload.installation.installationId,
            endpointId: initiatorEndpointId,
          },
          target: {
            machineId: selection.brokerMachineId,
            endpointId: input.projection.target.endpointId,
          },
        },
        claim: input.claim,
        activationSecretKey: input.activationSecretKey,
        installationSecretKey: input.installationSecretKey,
      });
      return brokerReadinessRequest;
    },
    target: input.projection.target,
    happyHomeDir: input.happyHomeDir,
    signal: input.signal,
  });
  if (readiness.kind !== 'available') {
    return {
      status: readiness.kind === 'broker_unavailable' ? 'unavailable' : 'denied',
      reason: readiness.kind,
    };
  }
  if (brokerReadinessRequest === null) {
    return { status: 'unavailable', reason: 'broker_readiness_request_unavailable' };
  }
  return {
    status: 'ready',
    readiness: signRunnerReadinessV1({
      payload: {
        v: 1,
        purpose: 'happier.ephemeral-session-runner.readiness',
        claim: input.claim.payload,
        launchManifestCommitment: input.launchManifestCommitment,
        installation: {
          agentTarget: target,
          agentRuntimeId: input.preparation.pluginRuntime.selected.runtimeSpec.id,
          executablePath: input.preparation.managed.resolution.command,
          authoritativeVersion: null,
        },
        credentialSelectionBinding: selection,
        brokerReadinessRequest,
      },
      activationSecretKey: input.activationSecretKey,
      installationSecretKey: input.installationSecretKey,
    }),
  };
}
