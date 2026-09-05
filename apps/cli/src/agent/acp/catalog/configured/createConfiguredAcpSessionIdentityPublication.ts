import type { AcpSessionIdentityPublication } from '@/agent/acp/runtime/sessionIdentityBinding';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createVendorResumeIdMetadataPublisher } from '@/session/metadata/createVendorResumeIdMetadataPublisher';

/**
 * Session identity publication for configured (user-defined) ACP backends.
 *
 * Unlike built-in catalog agents, a configured backend is an arbitrary ACP
 * adapter: some implement `session/load` (vendor resume), many do not. The ACP
 * `initialize` handshake advertises this via `agentCapabilities.loadSession`,
 * so publication is gated on the adapter's declared capability at bind time:
 * adapters without load support publish nothing, their sessions carry no
 * `customAcpSessionId`, and the runtime_checked resume policy keeps resume
 * unavailable for them instead of failing against an adapter that cannot load.
 */
export function createConfiguredAcpSessionIdentityPublication(params: Readonly<{
  session: ApiSessionClient;
  isSessionLoadSupported: () => boolean;
}>): AcpSessionIdentityPublication {
  const publisher = createVendorResumeIdMetadataPublisher({
    agentId: 'customAcp',
    getMetadataSnapshot: () => params.session.getMetadataSnapshot(),
    updateMetadata: (updater) => params.session.updateMetadata(updater),
  });
  return {
    kind: 'persist-bound',
    persistBound: async (event) => {
      if (!params.isSessionLoadSupported()) return;
      await publisher.persistBound(event);
    },
  };
}
