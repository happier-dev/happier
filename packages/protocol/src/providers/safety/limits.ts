import { PROVIDER_CATALOG_LIMITS_V1 } from '../catalog/limits.js';

export type ProviderEndpointSafetyLimits = Readonly<{
  maxUrlChars: number;
  maxHostnameChars: number;
  maxPathChars: number;
  maxQueryChars: number;
  maxPublicHeaders: number;
  maxHeaderNameChars: number;
  maxHeaderValueChars: number;
  maxRedirects: number;
  maxWallTimeMs: number;
  maxIdleTimeMs: number;
  maxDecodedBodyBytes: number;
  maxModels: number;
  maxModelIdChars: number;
  maxModelNameChars: number;
  maxModelDescriptionChars: number;
}>;

export const PROVIDER_ENDPOINT_SAFETY_LIMITS: ProviderEndpointSafetyLimits = Object.freeze({
  maxUrlChars: 8_192,
  maxHostnameChars: 253,
  maxPathChars: 4_096,
  maxQueryChars: 2_048,
  maxPublicHeaders: 64,
  maxHeaderNameChars: 128,
  maxHeaderValueChars: 4_096,
  maxRedirects: 5,
  maxWallTimeMs: 30_000,
  maxIdleTimeMs: 10_000,
  maxDecodedBodyBytes: PROVIDER_CATALOG_LIMITS_V1.maxCatalogResponseBytes,
  maxModels: PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection,
  maxModelIdChars: PROVIDER_CATALOG_LIMITS_V1.maxModelIdLength,
  maxModelNameChars: PROVIDER_CATALOG_LIMITS_V1.maxModelNameLength,
  maxModelDescriptionChars: PROVIDER_CATALOG_LIMITS_V1.maxModelDescriptionLength,
});
