/**
 * Connected services session bindings parser
 *
 * Spawn/session metadata includes non-secret binding decisions indicating which connected service
 * profile a session should use. This helper extracts the `(serviceId, profileId)` pairs that require
 * daemon-side credential resolution.
 */

import { ConnectedAccountServiceKeySchema, ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceBindingsV2 as ProtocolConnectedServicesBindingsV2, ConnectedAccountServiceKey, QualifiedConnectedAccountRef } from '@happier-dev/protocol';

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
    }>
  | Readonly<{
      kind: 'team_resource';
      serviceId: ConnectedAccountServiceKey;
      resourceId: string;
      deliveryMode: 'brokered';
    }>
  | Readonly<{
      kind: 'team_resource';
      serviceId: ConnectedAccountServiceKey;
      resourceId: string;
      deliveryMode: 'direct';
      disclosedMember: QualifiedConnectedAccountRef;
    }>;

export type ConnectedServicesBindingsV2 = ProtocolConnectedServicesBindingsV2;

// Admission preserves absence, but never recovers malformed explicit intent as native auth.
// The protocol ingress is the sole owner of current validation and released V1 normalization.
export const ConnectedServicesBindingsIngressSchema: ReturnType<typeof ConnectedServiceBindingsV2IngressSchema.optional> =
  ConnectedServiceBindingsV2IngressSchema.optional();

export function parseConnectedServiceBindingSelections(raw: unknown): ConnectedServiceBindingSelection[] {
  // Recovering metadata projection only; execution admission must validate with the schema above.
  const admitted = ConnectedServicesBindingsIngressSchema.safeParse(raw);
  if (!admitted.success || !admitted.data) return [];
  const bindings = admitted.data.bindingsByServiceId;

  const out: ConnectedServiceBindingSelection[] = [];
  for (const [serviceIdRaw, bindingRaw] of Object.entries(bindings)) {
    const serviceIdParsed = ConnectedAccountServiceKeySchema.safeParse(serviceIdRaw);
    if (!serviceIdParsed.success) continue;
    const serviceId = serviceIdParsed.data;
    const source = bindingRaw.source;
    if (source === 'team_resource') {
      out.push(bindingRaw.deliveryMode === 'direct'
        ? {
            kind: 'team_resource',
            serviceId,
            resourceId: bindingRaw.resourceId,
            deliveryMode: 'direct',
            disclosedMember: bindingRaw.disclosedMember,
          }
        : {
            kind: 'team_resource',
            serviceId,
            resourceId: bindingRaw.resourceId,
            deliveryMode: 'brokered',
          });
      continue;
    }
    if (source !== 'connected') continue;
    if (bindingRaw.selection === 'group') {
      out.push({
        kind: 'group',
        serviceId,
        groupId: bindingRaw.groupId,
        ...(bindingRaw.profileId ? { fallbackProfileId: bindingRaw.profileId } : {}),
      });
      continue;
    }
    out.push({ kind: 'profile', serviceId, profileId: bindingRaw.profileId });
  }
  return out;
}

export function parseConnectedServicesBindings(raw: unknown): Array<{ serviceId: ConnectedAccountServiceKey; profileId: string }> {
  return parseConnectedServiceBindingSelections(raw).flatMap((selection) => {
    if (selection.kind === 'profile') {
      return [{ serviceId: selection.serviceId, profileId: selection.profileId }];
    }
    return selection.kind === 'group' && selection.fallbackProfileId
      ? [{ serviceId: selection.serviceId, profileId: selection.fallbackProfileId }]
      : [];
  });
}
