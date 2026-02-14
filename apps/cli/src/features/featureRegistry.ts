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
