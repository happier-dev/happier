import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServicesLaunchAuthIntentV1 } from '@happier-dev/protocol/connect/connectedServicesLaunchAuthIntentV1';
import { resolveConnectedServicesLaunchAuthWithInventory } from '@happier-dev/protocol/connect/resolveConnectedServicesLaunchAuthV1';
import { ConnectedServicesDefaultUnavailableError } from '@/session/services/spawnConnectedServicesDefaults';

export { resolveConnectedServicesLaunchAuth, resolveConnectedServicesLaunchAuthWithInventory } from '@happier-dev/protocol/connect/resolveConnectedServicesLaunchAuthV1';
export type ConnectedServicesLaunchAuthIntent = ConnectedServicesLaunchAuthIntentV1;

function invalidLaunchAuth(message: string): never {
  throw new Error(
    `${message} Expected default, native, cs:<id>, cs:group:<id>, cs:profile:<id>, `
    + 'cs:<serviceId>:group:<id>, or cs:<serviceId>:profile:<id>.',
  );
}

function readNonBlank(value: string | undefined, message: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) invalidLaunchAuth(message);
  return normalized;
}

export function parseConnectedServicesLaunchAuth(raw: string): ConnectedServicesLaunchAuthIntent {
  const normalized = raw.trim();
  if (normalized === 'default') return { kind: 'default' };
  if (normalized === 'native') return { kind: 'native' };
  if (!normalized.startsWith('cs:')) {
    return invalidLaunchAuth(`Invalid connected-services auth selector "${normalized}".`);
  }

  const body = normalized.slice(3);
  const parts = body.split(':');
  if (parts.length === 1) {
    return {
      kind: 'connected',
      serviceId: null,
      selection: null,
      id: readNonBlank(parts[0], 'Missing connected-service id.'),
    };
  }
  if (parts[0] === 'group' || parts[0] === 'profile') {
    return {
      kind: 'connected',
      serviceId: null,
      selection: parts[0],
      id: readNonBlank(parts.slice(1).join(':'), `Missing connected-service ${parts[0]} id.`),
    };
  }
  if (parts.length >= 3 && (parts[1] === 'group' || parts[1] === 'profile')) {
    return {
      kind: 'connected',
      serviceId: readNonBlank(parts[0], 'Missing connected-service service id.'),
      selection: parts[1],
      id: readNonBlank(parts.slice(2).join(':'), `Missing connected-service ${parts[1]} id.`),
    };
  }
  return invalidLaunchAuth(`Invalid connected-services auth selector "${normalized}".`);
}

type ConnectedServicesLaunchDefaultDisposition =
  | Readonly<{ kind: 'connected'; bindings: ConnectedServiceBindingsV2 }>
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'unavailable';
      reason: ConstructorParameters<typeof ConnectedServicesDefaultUnavailableError>[0];
      catalogReason?: ConstructorParameters<typeof ConnectedServicesDefaultUnavailableError>[2];
    }>;

export async function resolveCliConnectedServicesLaunchBindings(params: Readonly<{
  authRaw: string | undefined;
  authJsonRaw: string | undefined;
  supportedServiceIds: readonly string[];
  defaultDisposition: ConnectedServicesLaunchDefaultDisposition;
  listInventory: () => Promise<unknown>;
}>): Promise<ConnectedServiceBindingsV2 | null> {
  if (params.authRaw !== undefined && params.authJsonRaw !== undefined) {
    throw new Error('connected_service_auth_conflict');
  }
  if (params.authJsonRaw !== undefined) {
    if (params.supportedServiceIds.length === 0) {
      throw new Error('connected_service_auth_unsupported');
    }
    try {
      return ConnectedServiceBindingsV2IngressSchema.parse(JSON.parse(params.authJsonRaw));
    } catch {
      throw new Error('connected_service_auth_json_invalid');
    }
  }

  const intent = parseConnectedServicesLaunchAuth(params.authRaw ?? 'default');
  if (intent.kind === 'default') {
    if (params.defaultDisposition.kind === 'unavailable') {
      throw new ConnectedServicesDefaultUnavailableError(params.defaultDisposition.reason, 'purpose_binding', params.defaultDisposition.catalogReason);
    }
    return params.defaultDisposition.kind === 'connected'
      ? params.defaultDisposition.bindings
      : null;
  }
  return await resolveConnectedServicesLaunchAuthWithInventory({
    intent,
    supportedServiceIds: params.supportedServiceIds,
    listInventory: params.listInventory,
  });
}
