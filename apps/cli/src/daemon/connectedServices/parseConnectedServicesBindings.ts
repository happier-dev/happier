/**
 * Connected services session bindings parser
 *
 * Spawn/session metadata includes non-secret binding decisions indicating which connected service
 * profile a session should use. This helper extracts the `(serviceId, profileId)` pairs that require
 * daemon-side credential resolution.
 */

import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServicesBindingsV1 = Readonly<{
  v: 1;
  bindingsByServiceId: Partial<Record<ConnectedServiceId, Readonly<{
    source: 'native' | 'connected';
    profileId?: string;
  }>>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseConnectedServicesBindings(raw: unknown): Array<{ serviceId: ConnectedServiceId; profileId: string }> {
  if (!isRecord(raw)) return [];
  if (raw.v !== 1) return [];
  const bindings = raw.bindingsByServiceId;
  if (!isRecord(bindings)) return [];

  const out: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
  for (const [serviceIdRaw, bindingRaw] of Object.entries(bindings)) {
    const parsedId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!parsedId.success) continue;
    if (!isRecord(bindingRaw)) continue;
    const source = bindingRaw.source;
    if (source !== 'connected') continue;
    const profileId = typeof bindingRaw.profileId === 'string' ? bindingRaw.profileId.trim() : '';
    if (!profileId) continue;
    out.push({ serviceId: parsedId.data, profileId });
  }
  return out;
}
