import {
  runTailscaleServeDisable,
  runTailscaleServeStatus,
  runTailscaleStatusJson,
  tailscaleServeHttpsUrlForOwnedConfigFromStatus,
  type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';

import type { DaemonTransferListenerState } from '@/api/types';

type ResolveTailscaleTransferListenerStateDeps = Readonly<{
  runTailscaleStatusJson?: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<TailscaleStatusSnapshot>;
  runTailscaleServeStatus?: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<string>;
  runTailscaleServeDisable?: (params: Readonly<{ env?: NodeJS.ProcessEnv; servePath?: string; httpsPort?: number }>) => Promise<void>;
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

  // `loggedIn` is the wrong question: serve config outlives `tailscale down`,
  // so a signed-in machine with a stopped backend would keep publishing a
  // configured transfer listener that no other device can reach. `available`
  // then reports whether tailscaled answered at all, which is what the daemon
  // previously learned from a thrown status error.
  if (!status.running) {
    return {
      enabled: params.enabled,
      configured: false,
      active: false,
      available: status.daemonReachable,
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

  if (!params.enabled && configured) {
    try {
      await (params.runTailscaleServeDisable ?? runTailscaleServeDisable)({
        ...(params.env ? { env: params.env } : {}),
        servePath: params.servePath,
        httpsPort: params.httpsPort,
      });
      return {
        enabled: false,
        configured: false,
        active: false,
        available: true,
      };
    } catch {
      // Best-effort enforcement only; fail open to reporting the configured state.
    }
  }

  return {
    enabled: params.enabled,
    configured,
    active: false,
    available: true,
  };
}
