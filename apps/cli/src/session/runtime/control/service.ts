import type {
  HostRuntimeControlAppServerDelegateV1,
  HostRuntimeControlAppServerRequestV1,
  HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
  HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
  HostRuntimeControlConnectedServiceRefreshInputV1,
  HostRuntimeControlConnectedServicesDelegateV1,
  HostRuntimeControlContextV1,
  HostRuntimeControlFailureCodeV1,
  HostRuntimeControlReachabilityDelegateV1,
  HostRuntimeControlReachabilityInputV1,
  HostRuntimeControlRequestOptionsV1,
  HostRuntimeControlResultV1,
  HostRuntimeControlServiceV1,
  HostRuntimeControlSessionDelegateV1,
} from '@happier-dev/agents';

export type CreateHostRuntimeControlServiceParams = Readonly<{
  agentId: string;
  context?: Omit<HostRuntimeControlContextV1, 'agentId'>;
  appServer?: HostRuntimeControlAppServerDelegateV1 | null;
  session?: HostRuntimeControlSessionDelegateV1 | null;
  connectedServices?: HostRuntimeControlConnectedServicesDelegateV1 | null;
  reachability?: HostRuntimeControlReachabilityDelegateV1 | null;
}>;

function failure<T = never>(
  code: HostRuntimeControlFailureCodeV1,
): HostRuntimeControlResultV1<T> {
  return {
    ok: false,
    code,
    error: code,
    diagnostics: [{ code }],
  };
}

function aborted<T = never>(): HostRuntimeControlResultV1<T> {
  return failure('runtime_control_aborted');
}

function failed<T = never>(
  code: HostRuntimeControlFailureCodeV1,
): HostRuntimeControlResultV1<T> {
  return failure(code);
}

const SAFE_FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,127}$/;

function normalizeFailureCode(
  code: string,
  fallback: HostRuntimeControlFailureCodeV1,
): string {
  return SAFE_FAILURE_CODE_PATTERN.test(code) ? code : fallback;
}

function sanitizeResult<T>(
  result: HostRuntimeControlResultV1<T>,
  fallbackCode: HostRuntimeControlFailureCodeV1,
): HostRuntimeControlResultV1<T> {
  if (result.ok) return result;
  const code = normalizeFailureCode(result.code, fallbackCode);
  return {
    ok: false,
    code,
    error: code,
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    diagnostics: [{ code }],
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function guarded<T>(
  options: HostRuntimeControlRequestOptionsV1 | undefined,
  code: HostRuntimeControlFailureCodeV1,
  run: () => Promise<HostRuntimeControlResultV1<T>>,
): Promise<HostRuntimeControlResultV1<T>> {
  if (options?.signal?.aborted) return aborted();
  try {
    return sanitizeResult(await run(), code);
  } catch (error) {
    return isAbortError(error) || options?.signal?.aborted ? aborted() : failed(code);
  }
}

function normalizeContext(params: CreateHostRuntimeControlServiceParams): HostRuntimeControlContextV1 {
  return {
    agentId: params.agentId,
    cwd: params.context?.cwd ?? null,
    metadata: params.context?.metadata ?? null,
    accountSettings: params.context?.accountSettings ?? null,
    processEnv: params.context?.processEnv ?? process.env,
    hostServices: params.context?.hostServices ?? {},
  };
}

export function createHostRuntimeControlService(
  params: CreateHostRuntimeControlServiceParams,
): HostRuntimeControlServiceV1 {
  const context = normalizeContext(params);
  return Object.freeze({
    context,
    appServer: Object.freeze({
      checkAvailable: async (
        input: Readonly<{ timeoutMs?: number | null }> | undefined,
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) => await guarded(options, 'app_server_control_failed', async () => {
        const checkAvailable = params.appServer?.checkAvailable;
        if (!checkAvailable) return failure('app_server_control_unavailable');
        return await checkAvailable({
          ...context,
          timeoutMs: input?.timeoutMs ?? null,
        }, options);
      }),
      request: async (
        input: HostRuntimeControlAppServerRequestV1,
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) =>
        await guarded(options, 'app_server_control_failed', async () => {
          const request = params.appServer?.request;
          if (!request) return failure('app_server_control_unavailable');
          return await request({
            ...context,
            method: input.method,
            params: input.params,
            timeoutMs: input.timeoutMs ?? null,
          }, options);
        }),
    }),
    session: Object.freeze({
      checkConnectedServiceAuthTransportInvalidation: async (
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) =>
        await guarded(options, 'session_transport_invalidation_failed', async () => {
          const check = params.session?.checkConnectedServiceAuthTransportInvalidation;
          if (!check) return failure('session_transport_unavailable');
          return await check(options);
        }),
      invalidateConnectedServiceAuthTransports: async (
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) =>
        await guarded(options, 'session_transport_invalidation_failed', async () => {
          const invalidate = params.session?.invalidateConnectedServiceAuthTransports;
          if (!invalidate) return failure('session_transport_unavailable');
          return await invalidate(options);
        }),
      applyConnectedServiceAuthGeneration: async (
        input: HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) =>
        await guarded(options, 'connected_service_auth_apply_failed', async () => {
          const apply = params.session?.applyConnectedServiceAuthGeneration;
          if (!apply) return failure('connected_service_auth_apply_unavailable');
          return await apply(input, options);
        }),
      readConnectedServiceRuntimeIdentity: async (
        input: HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) =>
        await guarded(options, 'connected_service_runtime_identity_failed', async () => {
          const read = params.session?.readConnectedServiceRuntimeIdentity;
          if (!read) return failure('connected_service_runtime_identity_unavailable');
          return await read(input, options);
        }),
    }),
    connectedServices: Object.freeze({
      refreshRuntimeAuth: async (
        input: HostRuntimeControlConnectedServiceRefreshInputV1,
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) =>
        await guarded(options, 'connected_service_refresh_failed', async () => {
          const refresh = params.connectedServices?.refreshRuntimeAuth;
          if (!refresh) return failure('connected_service_refresh_unavailable');
          return await refresh(input, options);
        }),
    }),
    reachability: Object.freeze({
      verifyMaterializedState: async (
        input: HostRuntimeControlReachabilityInputV1,
        options: HostRuntimeControlRequestOptionsV1 | undefined,
      ) =>
        await guarded(options, 'resume_reachability_failed', async () => {
          const verify = params.reachability?.verifyMaterializedState;
          if (!verify) return failure('resume_reachability_unavailable');
          return await verify(input, options);
        }),
    }),
  });
}
