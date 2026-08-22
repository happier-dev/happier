import { describe, expect, it } from 'vitest';

import {
  BUNDLED_PROVIDER_CATALOG_PARSERS_V1,
  ProviderCatalogParserV1Schema,
  ProviderCatalogProbeV1Schema,
  isBundledProviderCatalogParserV1,
  providerCatalogProbeReportsModelLoadStateV1,
  readBundledProviderCatalogParserFactV1,
} from './descriptorV1.js';

describe('provider catalog format identifier', () => {
  it('accepts a contributed format id alongside every bundled one', () => {
    for (const bundled of BUNDLED_PROVIDER_CATALOG_PARSERS_V1) {
      expect(ProviderCatalogParserV1Schema.parse(bundled)).toBe(bundled);
      expect(isBundledProviderCatalogParserV1(bundled)).toBe(true);
    }
    expect(ProviderCatalogParserV1Schema.parse('acme-catalog-v3')).toBe('acme-catalog-v3');
    expect(isBundledProviderCatalogParserV1('acme-catalog-v3')).toBe(false);
    expect(ProviderCatalogProbeV1Schema.parse({
      endpointTemplateId: 'api',
      path: '/v1/catalog',
      parser: 'acme-catalog-v3',
    })).toEqual({ endpointTemplateId: 'api', path: '/v1/catalog', parser: 'acme-catalog-v3' });
  });

  it('still rejects a malformed format id', () => {
    expect(() => ProviderCatalogParserV1Schema.parse('-leading-dash')).toThrow();
    expect(() => ProviderCatalogParserV1Schema.parse('has space')).toThrow();
    expect(() => ProviderCatalogParserV1Schema.parse('')).toThrow();
  });

  it('reports no bundled fact for a contributed format instead of borrowing one', () => {
    const facts = {
      'openai-models': 'openai',
      'anthropic-models': 'anthropic',
      'ollama-tags': 'ollama',
      'lmstudio-native-models': 'lmstudio',
    } as const;
    expect(readBundledProviderCatalogParserFactV1(facts, 'ollama-tags')).toBe('ollama');
    expect(readBundledProviderCatalogParserFactV1(facts, 'acme-catalog-v3')).toBeNull();
  });

  it('decides model-load state reporting from the format, not from bundled-ness', () => {
    expect(providerCatalogProbeReportsModelLoadStateV1({ parser: 'lmstudio-native-models' })).toBe(true);
    expect(providerCatalogProbeReportsModelLoadStateV1({ parser: 'openai-models' })).toBe(false);
    expect(providerCatalogProbeReportsModelLoadStateV1({ parser: 'acme-catalog-v3' })).toBe(false);
    expect(providerCatalogProbeReportsModelLoadStateV1({
      parser: 'acme-catalog-v3',
      reportsModelLoadState: true,
    })).toBe(true);
    expect(providerCatalogProbeReportsModelLoadStateV1({
      parser: 'lmstudio-native-models',
      reportsModelLoadState: false,
    })).toBe(false);
  });
});
