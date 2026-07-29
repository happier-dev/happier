import type { AcpCatalogTransportProfileV1 } from '@happier-dev/protocol';

import type { TransportHandler } from '@/agent/transport/TransportHandler';
import { DefaultTransport } from '@/agent/transport';

export function resolveAcpCatalogTransportHandler(profile: AcpCatalogTransportProfileV1): TransportHandler {
  return new DefaultTransport(profile);
}
