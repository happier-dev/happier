import type { ConnectedServiceQuotaFetcher } from '../types';

export function createGeminiQuotaFetcher(): ConnectedServiceQuotaFetcher {
  return {
    serviceId: 'gemini',
    fetch: async () => null,
  };
}

