import {
  resolveProviderBindingCompatibilityWithFingerprintV1,
  type AgentProviderRequirementsV1,
  type ProviderModelDescriptorV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import type { ResolvedProviderConnectionRecord } from '../registry';
import { resolveProviderSourceFacts } from '../registry/sourceFacts';

export function hasProviderExperimentalConfirmation(input: Readonly<{
  providerSettings: ProviderSettingsV1;
  connectionId: string;
  agentTargetKey: string;
  modelId: string;
  compatibilityFingerprint: string;
  confirmationScope: Readonly<{ kind: 'connection' } | { kind: 'model'; modelId: string }>;
}>): boolean {
  const expectedModelId = input.confirmationScope.kind === 'model' ? input.modelId : null;
  return input.providerSettings.experimentalBindingConfirmations.some((confirmation) =>
    confirmation.connectionId === input.connectionId
    && confirmation.agentTargetKey === input.agentTargetKey
    && confirmation.modelId === expectedModelId
    && confirmation.compatibilityFingerprint === input.compatibilityFingerprint);
}

/** Atomic compatibility result/fingerprint/confirmation owner for spawn and projection. */
export function resolveProviderModelCompatibility(input: Readonly<{
  record: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
  agentTargetKey: string;
  support: AgentProviderRequirementsV1;
  adapterVersion: number;
  model: ProviderModelDescriptorV1;
}>) {
  const facts = resolveProviderSourceFacts(input.record);
  const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({
    agentTargetKey: input.agentTargetKey,
    endpoints: facts.endpointTemplates,
    credential: facts.credential,
    agent: input.support,
    model: input.model,
    compatibilityOverrides: facts.compatibilityOverrides,
    adapterVersion: input.adapterVersion,
  });
  return Object.freeze({
    ...compatibility,
    confirmed: compatibility.result.status === 'experimental'
      ? hasProviderExperimentalConfirmation({
          providerSettings: input.providerSettings,
          connectionId: input.record.connectionId,
          agentTargetKey: input.agentTargetKey,
          modelId: input.model.id,
          compatibilityFingerprint: compatibility.compatibilityFingerprint,
          confirmationScope: compatibility.result.confirmationScope,
        })
      : compatibility.result.status === 'verified',
  });
}
