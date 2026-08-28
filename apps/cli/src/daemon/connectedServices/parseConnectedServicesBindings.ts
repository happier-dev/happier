/**
 * Connected services session bindings parser
 *
 * Spawn/session metadata includes non-secret binding decisions indicating which connected service
 * profile a session should use. This helper extracts the `(serviceId, profileId)` pairs that require
 * daemon-side credential resolution.
 */

import {
  BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedAccountServiceKey,
  type ConnectedServiceBindingsV1 as ProtocolConnectedServicesBindingsV1,
} from '@happier-dev/protocol';

export type ConnectedServiceBindingSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedAccountServiceKey;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      fallbackProfileId?: string;
    }>;

export type ConnectedServicesBindingsV1 = ProtocolConnectedServicesBindingsV1;

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseConnectedServiceBindingSelections(raw: unknown): ConnectedServiceBindingSelection[] {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  const admitted = parsed.success
    ? parsed
    : BuiltInLegacyConnectedServiceBindingsV1IngressSchema.safeParse(raw);
  if (!admitted.success) return [];
  const bindings = admitted.data.bindingsByServiceId;

  const out: ConnectedServiceBindingSelection[] = [];
  for (const [serviceIdRaw, bindingRaw] of Object.entries(bindings)) {
    const serviceId = serviceIdRaw as ConnectedAccountServiceKey;
    const source = bindingRaw.source;
    if (source !== 'connected') continue;
    const profileId = readTrimmedString(bindingRaw.profileId);
    const selection = readTrimmedString(bindingRaw.selection);
    if (selection === 'group') {
      const groupId = readTrimmedString(bindingRaw.groupId);
      if (!groupId) continue;
      out.push({
        kind: 'group',
        serviceId,
        groupId,
        ...(profileId ? { fallbackProfileId: profileId } : {}),
      });
      continue;
    }
    if (!profileId) continue;
    out.push({ kind: 'profile', serviceId, profileId });
  }
  return out;
}

export function parseConnectedServicesBindings(raw: unknown): Array<{ serviceId: ConnectedAccountServiceKey; profileId: string }> {
  return parseConnectedServiceBindingSelections(raw).flatMap((selection) => {
    if (selection.kind === 'profile') {
      return [{ serviceId: selection.serviceId, profileId: selection.profileId }];
    }
    return selection.fallbackProfileId
      ? [{ serviceId: selection.serviceId, profileId: selection.fallbackProfileId }]
      : [];
  });
}
