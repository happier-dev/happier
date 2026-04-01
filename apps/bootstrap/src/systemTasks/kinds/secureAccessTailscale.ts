import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import {
  resolveTailscaleInstallStrategy,
  runTailscaleLogin,
  runTailscaleStatusJson,
  type RunTailscaleLoginResult,
  type TailscaleSecureAccessTaskResult,
  type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';
import {
  createRelayAccessConfigureTaskKind,
  type RelayAccessTaskTarget,
} from '@happier-dev/cli-common/systemTasks';
import {
  getRelayAccessProvider,
  type RelayAccessConfig,
  type RelayAccessExecutionContext,
  type RelayAccessProvider,
  type RelayAccessProviderId,
} from '@happier-dev/cli-common/relayAccess';

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
  relayAccess: Readonly<{
    getProvider: (providerId: RelayAccessProviderId) => RelayAccessProvider;
    writeConfig: (params: Readonly<{ target: RelayAccessTaskTarget; config: RelayAccessConfig | null }>) => Promise<void>;
    createExecutionContext: (params: Readonly<{ target: RelayAccessTaskTarget; upstreamUrl: string | null }>) => RelayAccessExecutionContext;
  }>;
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
      stepId: 'tailscale.detect',
      message: 'Checking Tailscale secure-access status',
    };

    let state = await deps.inspectState(parsed);

    if (parsed.mode === 'managedAdmin') {
      const docsUrl = resolveTailscaleInstallStrategy(process.platform, process.env).docsUrl;
      if (!state.installed) {
        yield {
          type: 'prompt',
          stepId: 'tailscale.install',
          message: 'Install Tailscale to continue',
          data: {
            kind: 'tailscaleInstall',
            platform: process.platform,
            url: docsUrl,
          },
        };
        throw new systemTasks.SystemTaskExecutionError(
          'prompt_required',
          'Install Tailscale and rerun secure access setup.',
        );
      }

      if (!state.loggedIn) {
        const actionUrl = state.authUrl ?? docsUrl;
        yield {
          type: 'prompt',
          stepId: 'tailscale.login',
          message: 'Complete Tailscale sign-in to continue',
          data: {
            kind: 'needsUserAction.openUrl',
            url: actionUrl,
            usedQr: false,
          },
        };
        throw new systemTasks.SystemTaskExecutionError(
          'prompt_required',
          'Complete Tailscale sign-in before enabling secure access.',
        );
      }
    }

    if (!state.installed) {
      if (parsed.installPolicy === 'installIfMissing') {
        yield {
          type: 'progress',
          stepId: 'tailscale.install',
          message: 'Installing Tailscale (you may see system prompts)',
        };

        const install = await deps.ensureInstalled({ signal: context?.signal });
        if (install.outcome === 'prompt') {
          const prompt = install.prompt;
          yield {
            type: 'prompt',
            stepId: 'tailscale.install',
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
          stepId: 'tailscale.install',
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
      const loginActionUrl = login.actionUrl ?? state.authUrl;
      if (loginActionUrl) {
        yield {
          type: 'prompt',
          stepId: 'tailscale.login',
          message: 'Complete Tailscale sign-in to continue',
          data: {
            kind: login.actionUrl
              ? (login.usedQr ? 'needsUserAction.scanQr' : 'needsUserAction.openUrl')
              : 'needsUserAction.openUrl',
            url: loginActionUrl,
            usedQr: login.usedQr,
          },
        };
      } else {
        yield {
          type: 'progress',
          stepId: 'tailscale.login',
          message: 'Started interactive Tailscale sign-in',
          data: {
            kind: 'tailscaleLogin',
            usedQr: login.usedQr,
          },
        };
      }

      state = await deps.inspectState(parsed);
      if (!state.loggedIn) {
        const loginPollTimeoutMs = readBoundedIntEnv(
          'HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS',
          60_000,
          { min: 0, max: 600_000 },
        );
        const loginPollIntervalMs = readBoundedIntEnv(
          'HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS',
          1_000,
          { min: 1, max: 60_000 },
        );
        const maxAttempts = Math.max(1, Math.ceil(loginPollTimeoutMs / loginPollIntervalMs));

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          if (context?.signal?.aborted) {
            throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
          }

          const refreshed = await deps.inspectState(parsed);
          if (refreshed.loggedIn) {
            state = refreshed;
            break;
          }

          yield {
            type: 'progress',
            stepId: 'tailscale.login',
            message: attempt === 0 ? 'Waiting for Tailscale sign-in' : 'Still waiting for Tailscale sign-in',
          };
          if (attempt < maxAttempts - 1) {
            await deps.sleep(loginPollIntervalMs, context?.signal);
          }
        }

        if (!state.loggedIn) {
          throw new systemTasks.SystemTaskExecutionError(
            'prompt_required',
            'Complete Tailscale sign-in before enabling secure access.',
          );
        }
      }
    }

    if (state.shareableHttpsUrl) {
      yield {
        type: 'progress',
        stepId: 'tailscale.verifyUrl',
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
      stepId: 'tailscale.serveEnable',
      message: 'Enabling Tailscale Serve for secure access',
    };

    const secureAccessResult = await createRelayAccessConfigureTaskKind({
      writeConfig: async (params) => {
        await deps.relayAccess.writeConfig({
          target: params.target,
          config: params.config,
        });
      },
      getProvider: deps.relayAccess.getProvider,
      createExecutionContext: deps.relayAccess.createExecutionContext,
    }).run({
      params: {
        target: { kind: 'local' },
        upstreamUrl: parsed.upstreamUrl,
        providerId: 'tailscaleServe',
        config: { providerId: 'tailscaleServe' },
      },
      emit: () => undefined,
      prompt: async () => {
        throw new systemTasks.SystemTaskExecutionError('prompt_required', 'Relay access configuration does not require prompts.');
      },
    });

    const approvalUrl = resolveApprovalUrlFromRelayAccessDetails(secureAccessResult.status.details);
    if (approvalUrl) {
      yield {
        type: 'prompt',
        stepId: 'tailscale.serveEnable',
        message: 'Approve Tailscale Serve in your tailnet',
        data: {
          kind: 'tailscaleServeApproval',
          url: approvalUrl,
        },
      };

      let approvedUrl: string | null = null;
      const approvalPollTimeoutMs = readBoundedIntEnv(
        'HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS',
        60_000,
        { min: 0, max: 600_000 },
      );
      const approvalPollIntervalMs = readBoundedIntEnv(
        'HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS',
        1_000,
        { min: 1, max: 60_000 },
      );
      const maxAttempts = Math.max(1, Math.ceil(approvalPollTimeoutMs / approvalPollIntervalMs));

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
          stepId: 'tailscale.serveEnable',
          message: attempt === 0 ? 'Waiting for Tailscale Serve approval' : 'Still waiting for Tailscale Serve approval',
        };
        if (attempt < maxAttempts - 1) {
          await deps.sleep(approvalPollIntervalMs, context?.signal);
        }
      }

      if (!approvedUrl) {
        return {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: false,
          shareableHttpsUrl: null,
          requiresApproval: {
            url: approvalUrl,
          },
        };
      }

      yield {
        type: 'progress',
        stepId: 'tailscale.verifyUrl',
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

    const shareableHttpsUrl = secureAccessResult.status.shareUrl
      ? appendServePathToHttpsUrl(secureAccessResult.status.shareUrl, parsed.servePath)
      : (await deps.inspectState(parsed)).shareableHttpsUrl;
    if (!shareableHttpsUrl) {
      throw new systemTasks.SystemTaskExecutionError(
        'tailscale_serve_url_unavailable',
        'Tailscale Serve did not expose a shareable HTTPS URL.',
      );
    }

    yield {
      type: 'progress',
      stepId: 'tailscale.verifyUrl',
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
  const relayAccess = overrides?.relayAccess ?? {
    getProvider: (providerId: RelayAccessProviderId) => getRelayAccessProvider(providerId),
    writeConfig: async () => undefined,
    createExecutionContext: (params: Readonly<{ target: RelayAccessTaskTarget; upstreamUrl: string | null }>) => ({
      env: process.env,
      upstreamUrl: params.upstreamUrl,
    }),
  };

  return {
    inspectState: overrides?.inspectState ?? ((params) => inspectSecureAccessTailscaleState(params, relayAccess)),
    ensureInstalled: overrides?.ensureInstalled ?? (async (params) => await ensureTailscaleInstalled(params)),
    loginInteractive: overrides?.loginInteractive ?? (async () => await runTailscaleLogin()),
    relayAccess,
    sleep: overrides?.sleep ?? defaultSleep,
    now: overrides?.now ?? Date.now,
  };
}

function readBoundedIntEnv(
  envVarName: string,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const raw = process.env[envVarName];
  if (typeof raw !== 'string' || !raw.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

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
  relayAccess: SecureAccessTailscaleDeps['relayAccess'],
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

  const relayAccessProvider = relayAccess.getProvider('tailscaleServe');
  const relayAccessStatus = await relayAccessProvider.status({
    config: { providerId: 'tailscaleServe' },
    ctx: relayAccess.createExecutionContext({
      target: { kind: 'local' },
      upstreamUrl: params.upstreamUrl,
    }),
  });

  return {
    installed: true,
    loggedIn: true,
    authUrl: status.authUrl,
    shareableHttpsUrl: appendServePathToHttpsUrl(relayAccessStatus.shareUrl ?? null, params.servePath),
  };
}

function resolveApprovalUrlFromRelayAccessDetails(details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  const record = details as Record<string, unknown>;
  const approvalUrl = typeof record.approvalUrl === 'string' ? record.approvalUrl.trim() : '';
  return approvalUrl || null;
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
