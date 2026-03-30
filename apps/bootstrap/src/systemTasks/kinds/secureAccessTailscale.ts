import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import {
  extractTailscaleServeHttpsUrl,
  runTailscaleLogin,
  runTailscaleServeEnable,
  runTailscaleServeStatus,
  runTailscaleStatusJson,
  tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
  type RunTailscaleLoginResult,
  type RunTailscaleServeEnableResult,
  type TailscaleSecureAccessTaskResult,
  type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';

import { ensureTailscaleInstalled, type EnsureTailscaleInstalledResult } from '../../integrations/tailscale/ensureTailscaleInstalled.js';

type SecureAccessTailscaleParams = Readonly<{
  upstreamUrl: string;
  servePath: string;
  installPolicy: 'skip' | 'installIfMissing';
  loginPolicy: 'skip' | 'interactive';
  mode: 'normalUser' | 'managedAdmin';
}>;

type SecureAccessTailscaleState = Readonly<{
  installed: boolean;
  loggedIn: boolean;
  authUrl: string | null;
  shareableHttpsUrl: string | null;
}>;

type SecureAccessTailscaleDeps = Readonly<{
  inspectState: (params: SecureAccessTailscaleParams) => Promise<SecureAccessTailscaleState>;
  ensureInstalled: (params: Readonly<{ signal?: AbortSignal }>) => Promise<EnsureTailscaleInstalledResult>;
  loginInteractive: () => Promise<RunTailscaleLoginResult>;
  enableServe: (params: Readonly<{ upstreamUrl: string; servePath: string }>) => Promise<RunTailscaleServeEnableResult>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}>;

export function createSecureAccessTailscaleHandler(overrides?: Partial<SecureAccessTailscaleDeps>) {
  const deps = createSecureAccessTailscaleDeps(overrides);

  return async function* (
    params: unknown,
    context?: Readonly<{ signal?: AbortSignal }>,
  ): AsyncGenerator<
    Readonly<{
      type: 'progress' | 'prompt';
      stepId: string;
      message?: string;
      data?: Record<string, string | boolean>;
    }>,
    TailscaleSecureAccessTaskResult,
    void
  > {
    const parsed = parseSecureAccessTailscaleParams(params);

    yield {
      type: 'progress',
      stepId: 'detect',
      message: 'Checking Tailscale secure-access status',
    };

    let state = await deps.inspectState(parsed);
    if (!state.installed) {
      if (parsed.installPolicy === 'installIfMissing') {
        yield {
          type: 'progress',
          stepId: 'install',
          message: 'Installing Tailscale (you may see system prompts)',
        };

        const install = await deps.ensureInstalled({ signal: context?.signal });
        if (install.outcome === 'prompt') {
          const prompt = install.prompt;
          yield {
            type: 'prompt',
            stepId: 'install',
            message: 'Install Tailscale to continue',
            data: {
              kind: 'tailscaleInstall',
              platform: prompt.platform,
              url: prompt.url,
            },
          };
          throw new systemTasks.SystemTaskExecutionError(
            'prompt_required',
            install.prompt.reason === 'install_incomplete'
              ? 'Finish the Tailscale install flow and rerun secure access setup.'
              : 'Install Tailscale and rerun secure access setup.',
          );
        }

        state = await deps.inspectState(parsed);
      }

      if (!state.installed) {
        yield {
          type: 'progress',
          stepId: 'install',
          message: 'Tailscale install is still pending',
          data: {
            kind: 'tailscaleInstallPending',
          },
        };
      }
    }

    if (!state.installed) {
      throw new systemTasks.SystemTaskExecutionError(
        'tailscale_not_installed',
        'Install Tailscale before enabling secure access.',
      );
    }

    if (!state.loggedIn) {
      if (parsed.loginPolicy !== 'interactive') {
        throw new systemTasks.SystemTaskExecutionError(
          'tailscale_login_required',
          'Complete Tailscale sign-in before enabling secure access.',
        );
      }

      const login = await deps.loginInteractive();
      if (login.actionUrl) {
        yield {
          type: 'prompt',
          stepId: 'login',
          message: 'Complete Tailscale sign-in to continue',
          data: {
            kind: login.usedQr ? 'needsUserAction.scanQr' : 'needsUserAction.openUrl',
            url: login.actionUrl,
            usedQr: login.usedQr,
          },
        };
      } else {
        yield {
          type: 'progress',
          stepId: 'login',
          message: 'Started interactive Tailscale sign-in',
          data: {
            kind: 'tailscaleLogin',
            usedQr: login.usedQr,
          },
        };
      }

      state = await deps.inspectState(parsed);
      if (!state.loggedIn) {
        throw new systemTasks.SystemTaskExecutionError(
          'tailscale_login_required',
          'Complete Tailscale sign-in before enabling secure access.',
        );
      }
    }

    if (state.shareableHttpsUrl) {
      yield {
        type: 'progress',
        stepId: 'verify url',
        message: 'Verified Tailscale secure-access URL',
        data: {
          kind: 'tailscaleSecureAccessUrl',
          shareableHttpsUrl: state.shareableHttpsUrl,
        },
      };
      return {
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        serveEnabled: true,
        shareableHttpsUrl: state.shareableHttpsUrl,
        requiresApproval: null,
      };
    }

    yield {
      type: 'progress',
      stepId: 'serve enable',
      message: 'Enabling Tailscale Serve for secure access',
    };

    const enable = await deps.enableServe({
      upstreamUrl: parsed.upstreamUrl,
      servePath: parsed.servePath,
    });
    if (enable.approvalUrl) {
      yield {
        type: 'prompt',
        stepId: 'serve enable',
        message: 'Approve Tailscale Serve in your tailnet',
        data: {
          kind: 'tailscaleServeApproval',
          url: enable.approvalUrl,
        },
      };

      let approvedUrl: string | null = null;
      const maxAttempts = Math.max(1, Math.ceil(TAILSCALE_APPROVAL_POLL_TIMEOUT_MS / TAILSCALE_APPROVAL_POLL_INTERVAL_MS));

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (context?.signal?.aborted) {
          throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
        }

        const refreshed = await deps.inspectState(parsed);
        if (refreshed.shareableHttpsUrl) {
          approvedUrl = refreshed.shareableHttpsUrl;
          break;
        }

        yield {
          type: 'progress',
          stepId: 'serve enable',
          message: attempt === 0 ? 'Waiting for Tailscale Serve approval' : 'Still waiting for Tailscale Serve approval',
        };
        if (attempt < maxAttempts - 1) {
          await deps.sleep(TAILSCALE_APPROVAL_POLL_INTERVAL_MS, context?.signal);
        }
      }

      if (!approvedUrl) {
        return {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: false,
          shareableHttpsUrl: null,
          requiresApproval: {
            url: enable.approvalUrl,
          },
        };
      }

      yield {
        type: 'progress',
        stepId: 'verify url',
        message: 'Verified Tailscale secure-access URL',
        data: {
          kind: 'tailscaleSecureAccessUrl',
          shareableHttpsUrl: approvedUrl,
        },
      };

      return {
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        serveEnabled: true,
        shareableHttpsUrl: approvedUrl,
        requiresApproval: null,
      };
    }

    const shareableHttpsUrl = appendServePathToHttpsUrl(enable.httpsUrl, parsed.servePath)
      ?? (await deps.inspectState(parsed)).shareableHttpsUrl;
    if (!shareableHttpsUrl) {
      throw new systemTasks.SystemTaskExecutionError(
        'tailscale_serve_url_unavailable',
        'Tailscale Serve did not expose a shareable HTTPS URL.',
      );
    }

    yield {
      type: 'progress',
      stepId: 'verify url',
      message: 'Verified Tailscale secure-access URL',
      data: {
        kind: 'tailscaleSecureAccessUrl',
        shareableHttpsUrl,
      },
    };

    return {
      tailscaleInstalled: true,
      tailscaleLoggedIn: true,
      serveEnabled: true,
      shareableHttpsUrl,
      requiresApproval: null,
    };
  };
}

function createSecureAccessTailscaleDeps(overrides?: Partial<SecureAccessTailscaleDeps>): SecureAccessTailscaleDeps {
  return {
    inspectState: overrides?.inspectState ?? inspectSecureAccessTailscaleState,
    ensureInstalled: overrides?.ensureInstalled ?? (async (params) => await ensureTailscaleInstalled(params)),
    loginInteractive: overrides?.loginInteractive ?? (async () => await runTailscaleLogin()),
    enableServe: overrides?.enableServe ?? (async (params) => await runTailscaleServeEnable(params)),
    sleep: overrides?.sleep ?? defaultSleep,
    now: overrides?.now ?? Date.now,
  };
}

const TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = 60_000;
const TAILSCALE_APPROVAL_POLL_INTERVAL_MS = 1_000;

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const duration = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (duration <= 0) {
    return;
  }

  if (signal?.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, duration);

    const onAbort = () => {
      cleanup();
      reject(new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function inspectSecureAccessTailscaleState(
  params: SecureAccessTailscaleParams,
): Promise<SecureAccessTailscaleState> {
  let status: TailscaleStatusSnapshot;
  try {
    status = await runTailscaleStatusJson();
  } catch (error) {
    if (isUnavailableTailscaleError(error)) {
      return {
        installed: false,
        loggedIn: false,
        authUrl: null,
        shareableHttpsUrl: null,
      };
    }
    throw error;
  }

  if (!status.loggedIn) {
    return {
      installed: true,
      loggedIn: false,
      authUrl: status.authUrl,
      shareableHttpsUrl: null,
    };
  }

  const serveStatus = await runTailscaleServeStatus().catch(() => '');
  const upstream = String(params.upstreamUrl ?? '').trim();
  const httpsBaseUrl = upstream
    ? tailscaleServeHttpsUrlForInternalServerUrlFromStatus(serveStatus, upstream)
    : extractTailscaleServeHttpsUrl(serveStatus);

  return {
    installed: true,
    loggedIn: true,
    authUrl: status.authUrl,
    shareableHttpsUrl: appendServePathToHttpsUrl(httpsBaseUrl, params.servePath),
  };
}

function parseSecureAccessTailscaleParams(params: unknown): SecureAccessTailscaleParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_params',
      'Expected secure access params to be an object.',
    );
  }

  const record = params as Record<string, unknown>;
  const allowedKeys = new Set(['upstreamUrl', 'servePath', 'installPolicy', 'loginPolicy', 'mode']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `Unknown secure access param: ${key}`);
    }
  }

  return {
    upstreamUrl: ensureNonEmptyString(record.upstreamUrl, 'upstreamUrl'),
    servePath: normalizeServePath(record.servePath),
    installPolicy: record.installPolicy === 'installIfMissing' ? 'installIfMissing' : 'skip',
    loginPolicy: record.loginPolicy === 'skip' ? 'skip' : 'interactive',
    mode: record.mode === 'managedAdmin' ? 'managedAdmin' : 'normalUser',
  };
}

function normalizeServePath(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text === '/') {
    return '/';
  }
  return text.startsWith('/') ? text : `/${text}`;
}

function appendServePathToHttpsUrl(baseUrl: string | null, servePath: string): string | null {
  const rawBaseUrl = String(baseUrl ?? '').trim();
  if (!rawBaseUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    parsed.pathname = servePath;
    parsed.search = '';
    parsed.hash = '';
    const rendered = parsed.toString();
    return servePath === '/'
      ? rendered.replace(/\/+$/, '')
      : rendered.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isUnavailableTailscaleError(error: unknown): boolean {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error ?? '');
  return /(enoent|cli not found|not found|cannot find)/i.test(message);
}

function ensureNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', `Missing ${field}.`);
  }
  return text;
}
