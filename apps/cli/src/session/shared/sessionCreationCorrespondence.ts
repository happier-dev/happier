export { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import type { AgentSessionConfigurationSnapshotV1 } from '@happier-dev/protocol/runtime/agentSessionConfigurationV1';

/** Materialize only the configuration needed by an actual native-sandbox choice. */
export function withSessionNativeSandbox(
  configuration: AgentSessionConfigurationSnapshotV1 | null | undefined,
  nativeSandbox: 'on' | 'off' | undefined,
): AgentSessionConfigurationSnapshotV1 | undefined {
  if (nativeSandbox === undefined) return configuration ?? undefined;
  return { ...(configuration ?? {
    mode: { value: null, updatedAtMs: 0 },
    model: { value: null, updatedAtMs: 0, selectionSource: 'inherited' },
    permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
  }), nativeSandbox };
}
