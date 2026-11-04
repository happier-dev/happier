import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
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
  return Object.freeze({
    ...compatibility,
    confirmed: compatibility.result.status === 'experimental'
      ? input.teamCredentialResource !== undefined || hasProviderExperimentalConfirmation({
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
