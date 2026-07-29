import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

export type ConnectedServiceRuntimeSnapshot = Readonly<{
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readConnectedServices(value: unknown): ConnectedServiceBindingsV1 | undefined {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readConnectedServicesUpdatedAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readMaterializationIdentity(value: unknown): ConnectedServiceMaterializationIdentityV1 | undefined {
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function hasConnectedServiceBindings(
  snapshot: ConnectedServiceRuntimeSnapshot,
): snapshot is ConnectedServiceRuntimeSnapshot & Readonly<{ connectedServices: ConnectedServiceBindingsV1 }> {
  return Boolean(snapshot.connectedServices && Object.keys(snapshot.connectedServices.bindingsByServiceId).length > 0);
}

export function readConnectedServiceRuntimeSnapshot(value: unknown): ConnectedServiceRuntimeSnapshot {
  const record = readRecord(value);
  if (!record) return {};
  const connectedServices = readConnectedServices(record.connectedServices);
  const connectedServicesUpdatedAt = readConnectedServicesUpdatedAt(record.connectedServicesUpdatedAt);
  const connectedServiceMaterializationIdentityV1 = readMaterializationIdentity(
    record.connectedServiceMaterializationIdentityV1,
  );
  return {
    ...(connectedServices ? { connectedServices } : {}),
    ...(connectedServices && connectedServicesUpdatedAt !== undefined ? { connectedServicesUpdatedAt } : {}),
    ...(connectedServiceMaterializationIdentityV1 ? { connectedServiceMaterializationIdentityV1 } : {}),
  };
}

export function mergeConnectedServiceRuntimeSnapshots(
  primary: ConnectedServiceRuntimeSnapshot,
  fallback: ConnectedServiceRuntimeSnapshot,
): ConnectedServiceRuntimeSnapshot {
  const connectedServices = primary.connectedServices ?? fallback.connectedServices;
  return {
    ...(connectedServices ? { connectedServices } : {}),
    ...(connectedServices
      ? { connectedServicesUpdatedAt: primary.connectedServicesUpdatedAt ?? fallback.connectedServicesUpdatedAt }
      : {}),
    ...(primary.connectedServiceMaterializationIdentityV1 ?? fallback.connectedServiceMaterializationIdentityV1
      ? {
        connectedServiceMaterializationIdentityV1:
          primary.connectedServiceMaterializationIdentityV1 ?? fallback.connectedServiceMaterializationIdentityV1,
      }
      : {}),
  };
}
