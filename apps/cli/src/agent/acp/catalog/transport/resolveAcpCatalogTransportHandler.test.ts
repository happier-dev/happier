import { describe, expect, it } from 'vitest';

import { DefaultTransport } from '@/agent/transport';

import { resolveAcpCatalogTransportHandler } from './resolveAcpCatalogTransportHandler';

describe('resolveAcpCatalogTransportHandler', () => {
  it('uses the generic transport for the kiro profile', () => {
    const transport = resolveAcpCatalogTransportHandler('kiro');

    expect(transport).toBeInstanceOf(DefaultTransport);
    expect(transport.constructor).toBe(DefaultTransport);
  });

  it('returns the default transport for the generic profile', () => {
    expect(resolveAcpCatalogTransportHandler('generic')).toBeInstanceOf(DefaultTransport);
  });
});
