import type { FeatureId, FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

export type CliFeatureDefinition = Readonly<{
  id: FeatureId;
  serverRequired: boolean;
  serverEnabled: (features: ServerFeatures) => boolean;
}>;

const ALWAYS_ENABLED = () => true;

const CLI_FEATURE_REGISTRY: Readonly<Partial<Record<FeatureId, CliFeatureDefinition>>> = {
  automations: {
    id: 'automations',
    serverRequired: false,
    serverEnabled: (features) => features.features.automations.enabled === true,
  },
  'automations.existingSessionTarget': {
    id: 'automations.existingSessionTarget',
    serverRequired: false,
    serverEnabled: (features) =>
      features.features.automations.enabled === true && features.features.automations.existingSessionTarget === true,
  },
  bugReports: {
    id: 'bugReports',
    serverRequired: true,
    serverEnabled: (features) => features.features.bugReports.enabled === true,
  },
  'execution.runs': {
    id: 'execution.runs',
    // Execution runs are currently a client/daemon feature; the server features payload does not
    // yet advertise a dedicated gate. Keep this locally gated for now.
    serverRequired: false,
    serverEnabled: ALWAYS_ENABLED,
  },
  voice: {
    id: 'voice',
    // Voice can run fully locally; treat server gating as best-effort and rely on local policy in V1.
    // (If we later want server-enforced gating, we can flip serverRequired=true and plumb server snapshots.)
    serverRequired: false,
    serverEnabled: (features) => features.features.voice.enabled === true,
  },
  'connected.services': {
    id: 'connected.services',
    serverRequired: true,
    serverEnabled: (features) => features.features.connectedServices.enabled === true,
  },
  'connected.services.quotas': {
    id: 'connected.services.quotas',
    serverRequired: true,
    serverEnabled: (features) =>
      features.features.connectedServices.enabled === true &&
      features.features.connectedServices.quotas?.enabled === true,
  },
};

export function getCliFeatureDefinition(featureId: FeatureId): CliFeatureDefinition {
  return (
    CLI_FEATURE_REGISTRY[featureId] ?? {
      id: featureId,
      serverRequired: false,
      serverEnabled: ALWAYS_ENABLED,
    }
  );
}
