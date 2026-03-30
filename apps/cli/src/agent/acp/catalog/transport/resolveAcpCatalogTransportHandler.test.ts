import { describe, expect, it } from 'vitest';

import { DefaultTransport } from '@/agent/transport';
import { KiroTransport } from '@/backends/kiro/acp/transport';

import { resolveAcpCatalogTransportHandler } from './resolveAcpCatalogTransportHandler';

describe('resolveAcpCatalogTransportHandler', () => {
  it('returns a Kiro transport for the kiro profile', () => {
    expect(resolveAcpCatalogTransportHandler('kiro')).toBeInstanceOf(KiroTransport);
  });

  it('returns the default transport for the generic profile', () => {
    expect(resolveAcpCatalogTransportHandler('generic')).toBeInstanceOf(DefaultTransport);
  });
});
