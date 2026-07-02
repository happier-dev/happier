import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import {
  type TailscaleSecureAccessTaskResult,
} from '@happier-dev/cli-common/tailscale';
import {
  createRelayAccessConfigureTaskKind,
  parseSystemTaskSshConfig,
  type RelayAccessTaskTarget,
} from '@happier-dev/cli-common/systemTasks';
import {
  createRelayAccessDeadline,
  getRelayAccessProvider,
  type RelayAccessConfig,
  type RelayAccessExecutionContext,
  type RelayAccessProvider,
  type RelayAccessProviderId,
} from '@happier-dev/cli-common/relayAccess';
import {
  createTailscaleReadinessRuntimeDeps,
  readBoundedIntEnv,
  runTailscaleReadinessFlow,
  type TailscaleReadinessInspectionOptions,
  type TailscaleReadinessRuntimeDeps,
  type TailscaleReadinessState,
} from './tailscaleReadinessFlow.js';
import {
  inspectTailscaleReadinessStateForExecutionContext,
  resolveTailscaleInstallPromptForExecutionContext,
  runTailscaleLoginForExecutionContext,
} from './tailscaleExecutionContext.js';

type SecureAccessTailscaleParams = Readonly<{
  target: RelayAccessTaskTarget;
  upstreamUrl: string;
  providerId: 'tailscaleServe' | 'tailscaleFunnel';
  servePath: string;
  installPolicy: 'skip' | 'installIfMissing';
  loginPolicy: 'skip' | 'interactive';
  mode: 'normalUser' | 'managedAdmin';
}>;

type SecureAccessTailscaleDeps = Readonly<{
  inspectState: (params: SecureAccessTailscaleParams, options?: TailscaleReadinessInspectionOptions) => Promise<TailscaleReadinessState>;
  relayAccess: Readonly<{
    getProvider: (providerId: RelayAccessProviderId) => RelayAccessProvider;
    writeConfig: (params: Readonly<{ target: RelayAccessTaskTarget; config: RelayAccessConfig | null }>) => Promise<void>;
    createExecutionContext: (params: Readonly<{ target: RelayAccessTaskTarget; upstreamUrl: string | null }>) => RelayAccessExecutionContext;
  }>;
} & TailscaleReadinessRuntimeDeps<SecureAccessTailscaleParams>>;

const MIN_TAILSCALE_POLL_COMMAND_TIMEOUT_MS = 1;

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
    let state = yield* runTailscaleReadinessFlow(parsed, deps, context);

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
        target: serializeSecureAccessTailscaleTarget(parsed.target),
        upstreamUrl: parsed.upstreamUrl,
        providerId: parsed.providerId,
        config: { providerId: parsed.providerId },
      },
      ...(context?.signal ? { signal: context.signal } : {}),
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
      const approvalPollDeadline = createRelayAccessDeadline({
        timeoutMs: approvalPollTimeoutMs,
        now: deps.now,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      const approvalPollDeadlineMs = approvalPollDeadline.deadlineAt;
      let approvalPollAttempt = 0;

      while (true) {
        if (context?.signal?.aborted) {
          throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
        }
        const remainingPollMs = approvalPollDeadlineMs - deps.now();
        if (remainingPollMs < MIN_TAILSCALE_POLL_COMMAND_TIMEOUT_MS) {
          break;
        }

        const refreshed = await deps.inspectState(parsed, {
          timeoutMs: remainingPollMs,
          deadline: approvalPollDeadline,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        if (refreshed.shareableHttpsUrl) {
          approvedUrl = refreshed.shareableHttpsUrl;
          break;
        }

        yield {
          type: 'progress',
          stepId: 'tailscale.serveEnable',
          message: approvalPollAttempt === 0 ? 'Waiting for Tailscale Serve approval' : 'Still waiting for Tailscale Serve approval',
        };
        approvalPollAttempt += 1;
        const remainingSleepMs = approvalPollDeadlineMs - deps.now();
        if (remainingSleepMs <= 0) {
          break;
        }
        await deps.sleep(Math.min(approvalPollIntervalMs, remainingSleepMs), context?.signal);
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
  const readinessDeps = createTailscaleReadinessRuntimeDeps<SecureAccessTailscaleParams>(overrides);

  return {
    ...readinessDeps,
    ensureInstalled: overrides?.ensureInstalled ?? (async (params, options) => {
      if (params.target.kind === 'local') {
        return await readinessDeps.ensureInstalled(params, options);
      }

      const prompt = await resolveTailscaleInstallPromptForExecutionContext(
        relayAccess.createExecutionContext({
          target: params.target,
          upstreamUrl: params.upstreamUrl,
        }),
      );
      return {
        outcome: 'prompt',
        installerLaunched: false,
        prompt: {
          ...prompt,
          reason: 'manual_install_required',
        },
      };
    }),
    loginInteractive: overrides?.loginInteractive ?? (async (params) => {
      if (params.target.kind === 'local') {
        return await readinessDeps.loginInteractive(params);
      }

      return await runTailscaleLoginForExecutionContext(
        relayAccess.createExecutionContext({
          target: params.target,
          upstreamUrl: params.upstreamUrl,
        }),
      );
    }),
    resolveInstallPrompt: overrides?.resolveInstallPrompt ?? (async (params) => {
      if (params.target.kind === 'local') {
        return await readinessDeps.resolveInstallPrompt(params);
      }

      return await resolveTailscaleInstallPromptForExecutionContext(
        relayAccess.createExecutionContext({
          target: params.target,
          upstreamUrl: params.upstreamUrl,
        }),
      );
    }),
    inspectState: overrides?.inspectState ?? ((params, options) => inspectSecureAccessTailscaleState(params, relayAccess, options)),
    relayAccess,
  };
}

async function inspectSecureAccessTailscaleState(
  params: SecureAccessTailscaleParams,
  relayAccess: SecureAccessTailscaleDeps['relayAccess'],
  options?: TailscaleReadinessInspectionOptions,
): Promise<TailscaleReadinessState> {
  const executionContext = relayAccess.createExecutionContext({
    target: params.target,
    upstreamUrl: params.upstreamUrl,
  });
  const status = await inspectTailscaleReadinessStateForExecutionContext(executionContext, options);
  if (!status.installed || !status.loggedIn) {
    return {
      ...status,
    };
  }

  const relayAccessProvider = relayAccess.getProvider(params.providerId);
  const relayAccessStatus = await relayAccessProvider.status({
    config: { providerId: params.providerId },
    ctx: executionContext,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options?.deadline ? { deadline: options.deadline } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
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
  const allowedKeys = new Set(['target', 'upstreamUrl', 'providerId', 'servePath', 'installPolicy', 'loginPolicy', 'mode']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `Unknown secure access param: ${key}`);
    }
  }

  return {
    target: parseSecureAccessTailscaleTarget(record.target),
    upstreamUrl: ensureNonEmptyString(record.upstreamUrl, 'upstreamUrl'),
    providerId: record.providerId === 'tailscaleFunnel' ? 'tailscaleFunnel' : 'tailscaleServe',
    servePath: normalizeServePath(record.servePath),
    installPolicy: record.installPolicy === 'installIfMissing' ? 'installIfMissing' : 'skip',
    loginPolicy: record.loginPolicy === 'skip' ? 'skip' : 'interactive',
    mode: record.mode === 'managedAdmin' ? 'managedAdmin' : 'normalUser',
  };
}

function parseSecureAccessTailscaleTarget(value: unknown): RelayAccessTaskTarget {
  if (value == null) {
    return { kind: 'local' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Invalid secure access target.');
  }

  const record = value as Record<string, unknown>;
  if (record.kind === 'ssh') {
    return {
      kind: 'ssh',
      ssh: parseSystemTaskSshConfig(record.ssh),
    };
  }
  if (record.kind === 'local' || record.kind === undefined) {
    return { kind: 'local' };
  }

  throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Invalid secure access target.');
}

function serializeSecureAccessTailscaleTarget(target: RelayAccessTaskTarget): Readonly<{
  kind: 'local';
}> | Readonly<{
  kind: 'ssh';
  ssh: Record<string, string | number | boolean | null>;
}> {
  if (target.kind !== 'ssh') {
    return { kind: 'local' };
  }

  const ssh: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(target.ssh)) {
    if (value === undefined) {
      continue;
    }
    ssh[key] = value;
  }

  return {
    kind: 'ssh',
    ssh,
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

function ensureNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', `Missing ${field}.`);
  }
  return text;
}
