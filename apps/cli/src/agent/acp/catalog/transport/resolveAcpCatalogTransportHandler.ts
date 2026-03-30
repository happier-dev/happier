import type { AcpCatalogTransportProfileV1 } from '@happier-dev/protocol';

import type { TransportHandler } from '@/agent/transport/TransportHandler';
import { DefaultTransport } from '@/agent/transport';
import { KiroTransport } from '@/backends/kiro/acp/transport';

export function resolveAcpCatalogTransportHandler(profile: AcpCatalogTransportProfileV1): TransportHandler {
  switch (profile) {
    case 'kiro':
      return new KiroTransport();
    case 'generic':
    default:
      return new DefaultTransport(profile);
  }
}
