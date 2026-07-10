import type {
  SessionStateFieldId,
  SessionStateFieldValue,
} from '@happier-dev/protocol';

export type SessionStateUpdateV1<F extends SessionStateFieldId = SessionStateFieldId> = Readonly<{
  fieldId: F;
  value: SessionStateFieldValue<F>;
  updatedAt?: number;
}>;

export type BackendSurfaceDiagnosticV1 = Readonly<{
  code: string;
  severity?: 'info' | 'warning' | 'error';
  retryable?: boolean;
  safeMessage?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type BackendSurfaceOperationReceiptV1 = Readonly<{
  operationId?: string;
  providerOperationId?: string;
  diagnostics?: readonly BackendSurfaceDiagnosticV1[];
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type BackendSurfaceBaseFailureCodeV1 =
  | 'unsupported'
  | 'unavailable'
  | 'not_authorized'
  | 'invalid_request'
  | 'cancelled'
  | 'provider_error'
  | 'timeout';

export type BackendSurfaceResultV1<
  TValue,
  TCode extends string = BackendSurfaceBaseFailureCodeV1,
> =
  | Readonly<{
      ok: true;
      value: TValue;
      receipt?: BackendSurfaceOperationReceiptV1;
    }>
  | Readonly<{
      ok: false;
      code: TCode | BackendSurfaceBaseFailureCodeV1;
      message?: string;
      retryable?: boolean;
      receipt?: BackendSurfaceOperationReceiptV1;
      diagnostics?: readonly BackendSurfaceDiagnosticV1[];
    }>;

export type BackendSessionLaunchHintsV1 = Readonly<{
  directory?: string;
  /**
   * Provider-declared runtime-mode token needed to relaunch or take over this session.
   * Shared host code treats this as opaque; only the owning backend interprets it.
   */
  backendModeHint?: string;
  /**
   * Provider-owned additions to the host resume plan. Host-owned fields such as
   * directory, agent, resume id, transcript storage, and environment variables remain
   * authoritative and are not read from this object.
   */
  resumePlanOptions?: Readonly<Record<string, unknown>>;
  environmentVariables?: Readonly<Record<string, string>>;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;
