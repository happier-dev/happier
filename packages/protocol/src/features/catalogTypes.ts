import type { FeatureId } from './featureIds.js';

export type FeatureFailMode = 'fail_closed' | 'fail_open';

export type FeatureCatalogEntry = Readonly<{
  id: FeatureId;
  description: string;
  defaultFailMode: FeatureFailMode;
}>;
