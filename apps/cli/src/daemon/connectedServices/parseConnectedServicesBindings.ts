/**
 * Connected services session bindings parser
 *
 * Spawn/session metadata includes non-secret binding decisions indicating which connected service
 * profile a session should use. This helper extracts the `(serviceId, profileId)` pairs that require
 * daemon-side credential resolution.
 */

import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceBindingsV1 as ProtocolConnectedServicesBindingsV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceBindingSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      fallbackProfileId?: string;
    }>;

export type ConnectedServicesBindingsV1 = ProtocolConnectedServicesBindingsV1;

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseConnectedServiceBindingSelections(raw: unknown): ConnectedServiceBindingSelection[] {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  if (!parsed.success) return [];
  const bindings = parsed.data.bindingsByServiceId;

  const out: ConnectedServiceBindingSelection[] = [];
  for (const [serviceIdRaw, bindingRaw] of Object.entries(bindings)) {
    const parsedId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!parsedId.success) continue;
    const source = bindingRaw.source;
    if (source !== 'connected') continue;
    const profileId = readTrimmedString(bindingRaw.profileId);
    const selection = readTrimmedString(bindingRaw.selection);
    if (selection === 'group') {
      const groupId = readTrimmedString(bindingRaw.groupId);
      if (!groupId) continue;
      out.push({
        kind: 'group',
        serviceId: parsedId.data,
        groupId,
        ...(profileId ? { fallbackProfileId: profileId } : {}),
      });
      continue;
    }
    if (!profileId) continue;
    out.push({ kind: 'profile', serviceId: parsedId.data, profileId });
  }
  return out;
}

export function parseConnectedServicesBindings(raw: unknown): Array<{ serviceId: ConnectedServiceId; profileId: string }> {
  return parseConnectedServiceBindingSelections(raw).flatMap((selection) => {
    if (selection.kind === 'profile') {
      return [{ serviceId: selection.serviceId, profileId: selection.profileId }];
    }
    return selection.fallbackProfileId
      ? [{ serviceId: selection.serviceId, profileId: selection.fallbackProfileId }]
      : [];
  });
}
