import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import {
  createRelayAccessDeadline,
  type RelayAccessDeadlineV1,
} from '@happier-dev/cli-common/relayAccess';
import {
  resolveTailscaleInstallStrategy,
  runTailscaleLogin,
  runTailscaleStatusJson,
  type RunTailscaleLoginResult,
} from '@happier-dev/cli-common/tailscale';

import { ensureTailscaleInstalled, type EnsureTailscaleInstalledResult } from '../../integrations/tailscale/ensureTailscaleInstalled.js';

export type TailscaleReadinessInstallPolicy = 'skip' | 'installIfMissing';
export type TailscaleReadinessLoginPolicy = 'skip' | 'interactive';
export type TailscaleReadinessMode = 'normalUser' | 'managedAdmin';

export type TailscaleReadinessBaseParams = Readonly<{
  installPolicy: TailscaleReadinessInstallPolicy;
  loginPolicy: TailscaleReadinessLoginPolicy;
  mode: TailscaleReadinessMode;
}>;

export type TailscaleReadinessState = Readonly<{
  installed: boolean;
  /** Whether this machine has ever completed tailnet sign-in. */
  loggedIn: boolean;
  /** Whether tailscaled is up and carrying traffic right now. */
  running: boolean;
  /** Whether `tailscale status` reached the local tailscaled at all. */
  daemonReachable: boolean;
  authUrl: string | null;
  shareableHttpsUrl: string | null;
}>;

export type TailscaleReadinessInspectionOptions = Readonly<{
  timeoutMs?: number;
  deadline?: RelayAccessDeadlineV1;
  signal?: AbortSignal;
}>;

export type TailscaleReadinessRuntimeDeps<TParams extends TailscaleReadinessBaseParams = TailscaleReadinessBaseParams> = Readonly<{
  ensureInstalled: (
    params: TParams,
    options: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<EnsureTailscaleInstalledResult>;
  loginInteractive: (params: TParams) => Promise<RunTailscaleLoginResult>;
  resolveInstallPrompt: (
    params: TParams,
  ) => Promise<Readonly<{ platform: NodeJS.Platform; url: string }>> | Readonly<{ platform: NodeJS.Platform; url: string }>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}>;

export type TailscaleReadinessFlowDeps<TParams extends TailscaleReadinessBaseParams> =
  TailscaleReadinessRuntimeDeps<TParams> & Readonly<{
    inspectState: (params: TParams, options?: TailscaleReadinessInspectionOptions) => Promise<TailscaleReadinessState>;
  }>;

const MIN_TAILSCALE_POLL_COMMAND_TIMEOUT_MS = 1;

/**
 * Without a reachable tailscaled there is no login state to report, so
 * `loggedIn: false` must not be read as "sign in again" — the user needs to
 * start Tailscale, and re-running sign-in would not help.
 */
function assertTailscaleDaemonReachable(state: TailscaleReadinessState): void {
  if (state.installed && !state.daemonReachable) {
    throw new systemTasks.SystemTaskExecutionError(
      'tailscale_not_running',
      'Start Tailscale before enabling secure access.',
    );
  }
}

export function createTailscaleReadinessRuntimeDeps<TParams extends TailscaleReadinessBaseParams>(
  overrides?: Partial<TailscaleReadinessRuntimeDeps<TParams>>,
): TailscaleReadinessRuntimeDeps<TParams> {
  return {
    ensureInstalled: overrides?.ensureInstalled ?? (async (_params, options) => await ensureTailscaleInstalled(options)),
    loginInteractive: overrides?.loginInteractive ?? (async () => await runTailscaleLogin()),
    resolveInstallPrompt: overrides?.resolveInstallPrompt ?? (async () => ({
      platform: process.platform,
      url: resolveTailscaleInstallStrategy(process.platform, process.env).docsUrl,
    })),
    sleep: overrides?.sleep ?? defaultSleep,
    now: overrides?.now ?? Date.now,
  };
}

export async function* runTailscaleReadinessFlow<TParams extends TailscaleReadinessBaseParams>(
  params: TParams,
  deps: TailscaleReadinessFlowDeps<TParams>,
  context?: Readonly<{ signal?: AbortSignal }>,
): AsyncGenerator<
  Readonly<{
    type: 'progress' | 'prompt';
    stepId: string;
    message?: string;
    data?: Record<string, string | boolean>;
  }>,
  TailscaleReadinessState,
  void
> {
  yield {
    type: 'progress',
    stepId: 'tailscale.detect',
    message: 'Checking Tailscale secure-access status',
  };

  let state = await deps.inspectState(params, context?.signal ? { signal: context.signal } : undefined);

  if (params.mode === 'managedAdmin') {
    const installPrompt = await deps.resolveInstallPrompt(params);
    if (!state.installed) {
      yield {
        type: 'prompt',
        stepId: 'tailscale.install',
        message: 'Install Tailscale to continue',
        data: {
          kind: 'tailscaleInstall',
          platform: installPrompt.platform,
          url: installPrompt.url,
        },
      };
      throw new systemTasks.SystemTaskExecutionError(
        'prompt_required',
        'Install Tailscale and rerun secure access setup.',
      );
    }

    assertTailscaleDaemonReachable(state);

    if (!state.loggedIn) {
      const actionUrl = state.authUrl ?? installPrompt.url;
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
    if (params.installPolicy === 'installIfMissing') {
      yield {
        type: 'progress',
        stepId: 'tailscale.install',
        message: 'Installing Tailscale (you may see system prompts)',
      };

      const install = await deps.ensureInstalled(params, { signal: context?.signal });
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

      state = await deps.inspectState(params, context?.signal ? { signal: context.signal } : undefined);
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

  assertTailscaleDaemonReachable(state);

  if (!state.loggedIn) {
    if (params.loginPolicy !== 'interactive') {
      throw new systemTasks.SystemTaskExecutionError(
        'tailscale_login_required',
        'Complete Tailscale sign-in before enabling secure access.',
      );
    }

    const login = await deps.loginInteractive(params);
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

    state = await deps.inspectState(params, context?.signal ? { signal: context.signal } : undefined);
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
      const loginPollDeadline = createRelayAccessDeadline({
        timeoutMs: loginPollTimeoutMs,
        now: deps.now,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      const loginPollDeadlineMs = loginPollDeadline.deadlineAt;
      let loginPollAttempt = 0;

      while (true) {
        if (context?.signal?.aborted) {
          throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
        }
        const remainingPollMs = loginPollDeadlineMs - deps.now();
        if (remainingPollMs < MIN_TAILSCALE_POLL_COMMAND_TIMEOUT_MS) {
          break;
        }

        const refreshed = await deps.inspectState(params, {
          timeoutMs: remainingPollMs,
          deadline: loginPollDeadline,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        if (refreshed.loggedIn) {
          state = refreshed;
          break;
        }

        yield {
          type: 'progress',
          stepId: 'tailscale.login',
          message: loginPollAttempt === 0 ? 'Waiting for Tailscale sign-in' : 'Still waiting for Tailscale sign-in',
        };
        loginPollAttempt += 1;
        const remainingSleepMs = loginPollDeadlineMs - deps.now();
        if (remainingSleepMs <= 0) {
          break;
        }
        await deps.sleep(Math.min(loginPollIntervalMs, remainingSleepMs), context?.signal);
      }

      if (!state.loggedIn) {
        throw new systemTasks.SystemTaskExecutionError(
          'prompt_required',
          'Complete Tailscale sign-in before enabling secure access.',
        );
      }
    }
  }

  // Signed in is not the same as usable: a stopped backend keeps full node
  // identity, so this gate is what stops the flow from reporting readiness for
  // a machine whose relay nothing can reach.
  if (!state.running) {
    throw new systemTasks.SystemTaskExecutionError(
      'tailscale_not_running',
      'Start Tailscale before enabling secure access.',
    );
  }

  return state;
}

export async function inspectLocalTailscaleReadinessState(
  options?: TailscaleReadinessInspectionOptions,
): Promise<TailscaleReadinessState> {
  try {
    const status = await runTailscaleStatusJson({
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.deadline ? { deadline: options.deadline } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return {
      installed: true,
      loggedIn: status.loggedIn,
      running: status.running,
      daemonReachable: status.daemonReachable,
      authUrl: status.authUrl,
      shareableHttpsUrl: null,
    };
  } catch (error) {
    if (isUnavailableTailscaleError(error)) {
      return {
        installed: false,
        loggedIn: false,
        running: false,
        daemonReachable: false,
        authUrl: null,
        shareableHttpsUrl: null,
      };
    }
    throw error;
  }
}

export function readBoundedIntEnv(
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

export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export function isUnavailableTailscaleError(error: unknown): boolean {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error ?? '');
  return /(enoent|cli not found|not found|cannot find)/i.test(message);
}
