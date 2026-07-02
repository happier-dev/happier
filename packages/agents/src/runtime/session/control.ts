export type HostRuntimeControlDiagnosticV1 = Readonly<{
  code: string;
  message?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type HostRuntimeControlFailureCodeV1 =
  | 'runtime_control_aborted'
  | 'host_context_unavailable'
  | 'app_server_control_unavailable'
  | 'app_server_control_failed'
  | 'session_transport_unavailable'
  | 'session_transport_invalidation_failed'
  | 'connected_service_refresh_unavailable'
  | 'connected_service_refresh_failed'
  | 'resume_reachability_unavailable'
  | 'resume_reachability_failed';

export type HostRuntimeControlResultV1<T = unknown> =
  | Readonly<{
      ok: true;
      value: T;
      diagnostics?: readonly HostRuntimeControlDiagnosticV1[];
    }>
  | Readonly<{
      ok: false;
      code: HostRuntimeControlFailureCodeV1 | string;
      error: string;
      retryable?: boolean;
      diagnostics?: readonly HostRuntimeControlDiagnosticV1[];
    }>;

export type HostRuntimeControlRequestOptionsV1 = Readonly<{
  signal?: AbortSignal;
}>;

export type HostRuntimeControlContextV1 = Readonly<{
  agentId: string;
  cwd?: string | null;
  metadata?: unknown;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  processEnv?: Readonly<Record<string, string | undefined>>;
  hostServices?: Readonly<Record<string, unknown>>;
}>;

export type HostRuntimeControlAppServerRequestV1 = Readonly<{
  method: string;
  params?: unknown;
  timeoutMs?: number | null;
}>;

export type HostRuntimeControlAppServerDelegateInputV1 =
  HostRuntimeControlContextV1
  & HostRuntimeControlAppServerRequestV1;

export type HostRuntimeControlAppServerDelegateV1 = Readonly<{
  checkAvailable?: (
    input: HostRuntimeControlContextV1 & Readonly<{ timeoutMs?: number | null }>,
    options?: HostRuntimeControlRequestOptionsV1,
  ) => Promise<HostRuntimeControlResultV1<true>>;
  request?: (
    input: HostRuntimeControlAppServerDelegateInputV1,
    options?: HostRuntimeControlRequestOptionsV1,
  ) => Promise<HostRuntimeControlResultV1<unknown>>;
}>;

export type HostRuntimeControlSessionDelegateV1 = Readonly<{
  checkConnectedServiceAuthTransportInvalidation?: (
    options?: HostRuntimeControlRequestOptionsV1,
  ) => Promise<HostRuntimeControlResultV1<true>>;
  invalidateConnectedServiceAuthTransports?: (
    options?: HostRuntimeControlRequestOptionsV1,
  ) => Promise<HostRuntimeControlResultV1<true>>;
}>;

export type HostRuntimeControlConnectedServiceRefreshInputV1 = Readonly<{
  serviceId: string;
  profileId?: string | null;
  groupId?: string | null;
  selection?: unknown;
  classification?: unknown;
  reason?: string | null;
}>;

export type HostRuntimeControlConnectedServicesDelegateV1 = Readonly<{
  refreshRuntimeAuth?: (
    input: HostRuntimeControlConnectedServiceRefreshInputV1,
    options?: HostRuntimeControlRequestOptionsV1,
  ) => Promise<HostRuntimeControlResultV1<unknown>>;
}>;

export type HostRuntimeControlReachabilityInputV1 = Readonly<Record<string, unknown>>;

export type HostRuntimeControlReachabilityDelegateV1 = Readonly<{
  verifyMaterializedState?: (
    input: HostRuntimeControlReachabilityInputV1,
    options?: HostRuntimeControlRequestOptionsV1,
  ) => Promise<HostRuntimeControlResultV1<unknown>>;
}>;

export type HostRuntimeControlServiceV1 = Readonly<{
  context: HostRuntimeControlContextV1;
  appServer: Readonly<{
    checkAvailable: (
      input?: Readonly<{ timeoutMs?: number | null }>,
      options?: HostRuntimeControlRequestOptionsV1,
    ) => Promise<HostRuntimeControlResultV1<true>>;
    request: (
      input: HostRuntimeControlAppServerRequestV1,
      options?: HostRuntimeControlRequestOptionsV1,
    ) => Promise<HostRuntimeControlResultV1<unknown>>;
  }>;
  session: Readonly<{
    checkConnectedServiceAuthTransportInvalidation: (
      options?: HostRuntimeControlRequestOptionsV1,
    ) => Promise<HostRuntimeControlResultV1<true>>;
    invalidateConnectedServiceAuthTransports: (
      options?: HostRuntimeControlRequestOptionsV1,
    ) => Promise<HostRuntimeControlResultV1<true>>;
  }>;
  connectedServices: Readonly<{
    refreshRuntimeAuth: (
      input: HostRuntimeControlConnectedServiceRefreshInputV1,
      options?: HostRuntimeControlRequestOptionsV1,
    ) => Promise<HostRuntimeControlResultV1<unknown>>;
  }>;
  reachability: Readonly<{
    verifyMaterializedState: (
      input: HostRuntimeControlReachabilityInputV1,
      options?: HostRuntimeControlRequestOptionsV1,
    ) => Promise<HostRuntimeControlResultV1<unknown>>;
  }>;
}>;
