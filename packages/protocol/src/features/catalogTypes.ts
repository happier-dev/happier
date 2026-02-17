export type FeatureFailMode = 'fail_closed' | 'fail_open';

export type FeatureRepresentation = 'server' | 'client';

export type FeatureCatalogDefinitionEntry = Readonly<{
  description: string;
  defaultFailMode: FeatureFailMode;
  dependencies: readonly string[];
  representation: FeatureRepresentation;
}>;
