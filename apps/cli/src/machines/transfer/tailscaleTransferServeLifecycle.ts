import {
  runTailscaleServeDisable,
  runTailscaleServeEnable,
  type RunTailscaleServeEnableResult,
} from '@happier-dev/cli-common/tailscale';

import type { DaemonTransferListenerState } from '@/api/types';
import type { DirectTransferServerLifecycleState } from './directTransferServerLifecycle';

type TailscaleTransferServeLifecycleDeps = Readonly<{
  runTailscaleServeEnable?: (params: Readonly<{
    env?: NodeJS.ProcessEnv;
    upstreamUrl: string;
    servePath?: string;
    httpsPort?: number;
  }>) => Promise<RunTailscaleServeEnableResult>;
  runTailscaleServeDisable?: (params: Readonly<{
    env?: NodeJS.ProcessEnv;
    servePath?: string;
    httpsPort?: number;
  }>) => Promise<void>;
}>;

type TailscaleTransferServeLifecycleParams = Readonly<{
  enabled: boolean;
  servePath: string;
  httpsPort: number;
  env?: NodeJS.ProcessEnv;
  onListenerStateChange?: (state: DaemonTransferListenerState) => void;
  warn?: (message: string, error?: unknown) => void;
}> & TailscaleTransferServeLifecycleDeps;

function buildLoopbackUpstreamUrl(port: number | undefined): string | null {
  const normalizedPort = Number.isFinite(port) ? Math.trunc(port as number) : 0;
  if (normalizedPort <= 0) {
    return null;
  }
  return `http://127.0.0.1:${normalizedPort}`;
}

function normalizeServePath(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') {
    return '/';
  }
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/, '') || '/';
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isTailscaleUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(enoent|cli not found|not found|cannot find)/i.test(message);
}

export function createTailscaleTransferServeLifecycle(params: TailscaleTransferServeLifecycleParams): Readonly<{
  observeDirectTransferServerLifecycleState: (state: DirectTransferServerLifecycleState) => Promise<void>;
  getHttpsBaseUrlWithServePath: () => string | null;
  stop: () => Promise<void>;
}> {
  const runEnable = params.runTailscaleServeEnable ?? runTailscaleServeEnable;
  const runDisable = params.runTailscaleServeDisable ?? runTailscaleServeDisable;

  let desiredUpstreamUrl: string | null = null;
  let appliedUpstreamUrl: string | null = null;
  let appliedHttpsBaseUrl: string | null = null;
  let reconciliationInFlight: Promise<void> | null = null;
  let lastPublishedState: DaemonTransferListenerState = {
    enabled: params.enabled,
    configured: false,
    active: false,
    available: true,
  };

  const publishListenerState = (state: DaemonTransferListenerState): void => {
    lastPublishedState = state;
    params.onListenerStateChange?.(state);
  };

  const disableOwnedServePathBestEffort = async (): Promise<boolean> => {
    if (!appliedUpstreamUrl) {
      return true;
    }
    try {
      await runDisable({
        env: params.env ?? process.env,
        servePath: params.servePath,
        httpsPort: params.httpsPort,
      });
      appliedUpstreamUrl = null;
      appliedHttpsBaseUrl = null;
      publishListenerState({
        enabled: params.enabled,
        configured: false,
        active: false,
        available: true,
      });
      return true;
    } catch (error) {
      params.warn?.('[DAEMON RUN] Failed to disable transfer-specific Tailscale Serve mapping', error);
      publishListenerState({
        ...lastPublishedState,
        active: false,
      });
      return false;
    }
  };

  const reconcile = async (): Promise<void> => {
    if (!params.enabled) {
      desiredUpstreamUrl = null;
      appliedUpstreamUrl = null;
      appliedHttpsBaseUrl = null;
      publishListenerState({
        enabled: false,
        configured: false,
        active: false,
        available: lastPublishedState.available ?? true,
      });
      return;
    }

    if (!desiredUpstreamUrl) {
      await disableOwnedServePathBestEffort();
      return;
    }

    if (appliedUpstreamUrl === desiredUpstreamUrl && lastPublishedState.active) {
      return;
    }

    if (appliedUpstreamUrl && appliedUpstreamUrl !== desiredUpstreamUrl) {
      const disabled = await disableOwnedServePathBestEffort();
      if (!disabled) {
        return;
      }
    }

    try {
      const result = await runEnable({
        env: params.env ?? process.env,
        upstreamUrl: desiredUpstreamUrl,
        servePath: params.servePath,
        httpsPort: params.httpsPort,
      });

      const needsApproval = Boolean(result.approvalUrl);
      const hasHttpsUrl = Boolean(result.httpsUrl);
      const hasReadableStatus = Boolean(String(result.rawStatus ?? '').trim());

      // A successful enable command can mutate the owned Serve path even when the
      // immediate status readback is empty or not yet parseable. Retain cleanup
      // ownership unless the command explicitly stopped at the approval boundary.
      appliedUpstreamUrl = needsApproval ? null : desiredUpstreamUrl;
      appliedHttpsBaseUrl = hasHttpsUrl ? stripTrailingSlashes(String(result.httpsUrl)) : null;
      publishListenerState({
        enabled: true,
        configured: needsApproval || hasHttpsUrl,
        active: hasHttpsUrl && !needsApproval,
        available: hasReadableStatus || needsApproval || hasHttpsUrl,
      });
    } catch (error) {
      appliedUpstreamUrl = null;
      appliedHttpsBaseUrl = null;
      publishListenerState({
        enabled: true,
        configured: false,
        active: false,
        available: !isTailscaleUnavailableError(error),
      });
      params.warn?.('[DAEMON RUN] Failed to enable transfer-specific Tailscale Serve mapping', error);
    }
  };

  const scheduleReconcile = async (): Promise<void> => {
    if (reconciliationInFlight) {
      return await reconciliationInFlight;
    }
    reconciliationInFlight = (async () => {
      let previousDesired: string | null | undefined = undefined;
      while (true) {
        const nextDesired = desiredUpstreamUrl;
        if (previousDesired === nextDesired) {
          break;
        }
        previousDesired = nextDesired;
        await reconcile();
      }
    })().finally(() => {
      reconciliationInFlight = null;
    });
    return await reconciliationInFlight;
  };

  return {
    async observeDirectTransferServerLifecycleState(state) {
      desiredUpstreamUrl = state.status === 'running'
        ? buildLoopbackUpstreamUrl(state.port)
        : null;
      await scheduleReconcile();
    },

    getHttpsBaseUrlWithServePath() {
      if (!appliedHttpsBaseUrl || !lastPublishedState.active) {
        return null;
      }
      const servePath = normalizeServePath(params.servePath);
      if (servePath === '/') {
        return appliedHttpsBaseUrl;
      }
      return `${appliedHttpsBaseUrl}${servePath}`;
    },

    async stop() {
      desiredUpstreamUrl = null;
      await scheduleReconcile();
    },
  };
}
