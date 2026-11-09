export type FeatureFailMode = 'fail_closed' | 'fail_open';

export type FeatureRepresentation = 'server' | 'client';

export type FeatureCatalogDefinitionEntry = Readonly<{
  description: string;
  defaultFailMode: FeatureFailMode;
  dependencies: readonly string[];
  representation: FeatureRepresentation;
  /** Released spelling of another feature, never an independent decision. */
  aliasFor?: string;
}>;
