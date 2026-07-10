export const PROVIDER_CATALOG_LIMITS_V1 = Object.freeze({
  maxModelsPerConnection: 5_000,
  maxCatalogResponseBytes: 5 * 1024 * 1024,
  maxModelIdLength: 512,
  maxModelNameLength: 256,
  maxModelDescriptionLength: 1_024,
  maxCatalogProbes: 3,
} as const);
