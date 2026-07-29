import {
  DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
  MachineTunnelCapabilitiesSchema,
  type FeaturesResponse,
} from '@happier-dev/protocol';

import { resolveVoiceDaemonDirectRouteAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

export type VoiceQaTransportReadiness = Readonly<{
  machineControlPortAuthorized: boolean;
  directLoopbackEndpointReady: boolean;
  accountProfileReady: boolean;
  activeServerSocketReady: boolean;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function normalizePort(value: unknown): number | null {
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function resolveVoiceQaTransportReadiness(input: Readonly<{
  serverFeatures: Pick<FeaturesResponse, 'capabilities' | 'features'> | null | undefined;
  serverId: string | null | undefined;
  machineId: string | null | undefined;
  daemonHttpPort: unknown;
  directEndpoint: unknown;
  accountProfileId: unknown;
  socketStatus: unknown;
  activeSocketId: unknown;
}>): VoiceQaTransportReadiness {
  const tunnelCaps = MachineTunnelCapabilitiesSchema.safeParse(
    input.serverFeatures?.capabilities.machines.tunnel,
  );
  const daemonHttpPort = normalizePort(input.daemonHttpPort);
  const machineControlPortAuthorized = daemonHttpPort !== null
    && (tunnelCaps.success ? tunnelCaps.data : DEFAULT_MACHINE_TUNNEL_CAPABILITIES)
      .directPeer.allowedPorts.includes(daemonHttpPort);

  return {
    machineControlPortAuthorized,
    directLoopbackEndpointReady: resolveVoiceDaemonDirectRouteAvailability({
      serverFeatures: input.serverFeatures,
      serverId: input.serverId,
      machineId: input.machineId,
      endpoint: input.directEndpoint,
      daemonHttpPort,
    }) === 'available',
    accountProfileReady: normalizeNonEmptyString(input.accountProfileId) !== null,
    activeServerSocketReady: input.socketStatus === 'connected'
      && normalizeNonEmptyString(input.activeSocketId) !== null,
  };
}
