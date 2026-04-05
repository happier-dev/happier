import {
  runTailscaleServeStatus,
  runTailscaleStatusJson,
  tailscaleServeHttpsUrlForOwnedConfigFromStatus,
  type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';

import type { DaemonTransferListenerState } from '@/api/types';

type ResolveTailscaleTransferListenerStateDeps = Readonly<{
  runTailscaleStatusJson?: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<TailscaleStatusSnapshot>;
  runTailscaleServeStatus?: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<string>;
}>;

function buildLoopbackTransferUrl(transferPort: number): string | null {
  const normalizedPort = Number.isFinite(transferPort) ? Math.trunc(transferPort) : 0;
  if (normalizedPort <= 0) {
    return null;
  }
  return `http://127.0.0.1:${normalizedPort}`;
}

export async function resolveTailscaleTransferListenerState(params: Readonly<{
  enabled: boolean;
  transferPort: number;
  servePath: string;
  httpsPort: number;
  env?: NodeJS.ProcessEnv;
}> & ResolveTailscaleTransferListenerStateDeps): Promise<DaemonTransferListenerState> {
  const internalTransferUrl = buildLoopbackTransferUrl(params.transferPort);
  if (!internalTransferUrl) {
    return {
      enabled: params.enabled,
      configured: false,
      active: false,
      available: false,
    };
  }

  let status: TailscaleStatusSnapshot;
  try {
    status = await (params.runTailscaleStatusJson ?? runTailscaleStatusJson)({
      ...(params.env ? { env: params.env } : {}),
    });
  } catch {
    return {
      enabled: params.enabled,
      configured: false,
      active: false,
      available: false,
    };
  }

  if (!status.loggedIn) {
    return {
      enabled: params.enabled,
      configured: false,
      active: false,
      available: true,
    };
  }

  let serveStatus = '';
  try {
    serveStatus = await (params.runTailscaleServeStatus ?? runTailscaleServeStatus)({
      ...(params.env ? { env: params.env } : {}),
    });
  } catch {
    return {
      enabled: params.enabled,
      configured: false,
      active: false,
      available: false,
    };
  }

  const configured = Boolean(
    tailscaleServeHttpsUrlForOwnedConfigFromStatus({
      serveStatusText: serveStatus,
      internalServerUrl: internalTransferUrl,
      servePath: params.servePath,
      httpsPort: params.httpsPort,
    }),
  );

  return {
    enabled: params.enabled,
    configured,
    active: false,
    available: true,
  };
}
