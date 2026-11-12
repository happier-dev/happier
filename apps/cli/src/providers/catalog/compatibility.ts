import { isProviderBindingCompatibilityDeclarationSatisfiableV1, resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { hasProviderExperimentalConfirmation } from '@happier-dev/protocol/providers/settings/v1';
import type { AgentProviderRequirementsV1, ProviderModelDescriptorV1, ProviderSettingsV1 } from '@happier-dev/protocol';

import type { ResolvedProviderConnectionRecord } from '../registry';
import { resolveProviderSourceFacts } from '../registry/sourceFacts';

export { hasProviderExperimentalConfirmation };

/** Atomic compatibility result/fingerprint/confirmation owner for spawn and projection. */
export function resolveProviderModelCompatibility(input: Readonly<{
  record: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
  agentTargetKey: string;
  support: AgentProviderRequirementsV1;
  adapterVersion: number;
  model: ProviderModelDescriptorV1;
  /** A current Team resource is admitted by its owning source, independently of personal consent. */
  teamCredentialResource?: Readonly<{ resourceId: string; resourceRevision: number }>;
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
  const declaredManagedModel = input.record.deployment.kind === 'managedLocal'
    && 'staticModels' in facts.catalog
    && facts.catalog.staticModels.some(model => model.id === input.model.id);
  return resolveProviderCompatibilityConfirmation({ compatibility, declaredManagedModel,
    providerSettings: input.providerSettings, confirmationSource: { connectionId: input.record.connectionId },
    agentTargetKey: input.agentTargetKey, modelId: input.model.id,
    teamCredentialResource: input.teamCredentialResource });
}

/** Shared consent decision for saved connections and exact Connected Account sources. */
export function resolveProviderCompatibilityConfirmation(input: Readonly<{
  compatibility: ReturnType<typeof resolveProviderBindingCompatibilityWithFingerprintV1>;
  declaredManagedModel: boolean;
  providerSettings?: Pick<ProviderSettingsV1, 'experimentalBindingConfirmations'> | null;
  confirmationSource: Pick<Parameters<typeof hasProviderExperimentalConfirmation>[0], 'connectionId' | 'catalogSourceKey' | 'connectedAccountTarget'>;
  agentTargetKey: string;
  modelId: string;
  teamCredentialResource?: Readonly<{ resourceId: string; resourceRevision: number }>;
}>) {
  const { compatibility } = input;
  const declarationSatisfiesEvidence = input.declaredManagedModel
    && isProviderBindingCompatibilityDeclarationSatisfiableV1(compatibility.result);
  return Object.freeze({
    ...compatibility,
    confirmed: compatibility.result.status === 'experimental'
      ? declarationSatisfiesEvidence || input.teamCredentialResource !== undefined || Boolean(input.providerSettings && hasProviderExperimentalConfirmation({
          providerSettings: input.providerSettings,
          ...input.confirmationSource,
          agentTargetKey: input.agentTargetKey,
          modelId: input.modelId,
          compatibilityFingerprint: compatibility.compatibilityFingerprint,
          confirmationScope: compatibility.result.confirmationScope,
        }))
      : compatibility.result.status === 'verified',
  });
}
