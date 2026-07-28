export type AcpAuthenticationSelection = Readonly<{
  methodId: string;
  meta?: Readonly<Record<string, unknown>>;
}>;

export type AcpAuthenticationResolverContext = Readonly<{
  advertisedMethodIds: ReadonlySet<string>;
  initializeMeta: Readonly<Record<string, unknown>> | null;
}>;

export type AcpAuthentication =
  | Readonly<{
      kind: 'static';
      methodId: string;
      meta?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: 'resolve-after-initialize';
      resolve: (context: AcpAuthenticationResolverContext) => AcpAuthenticationSelection;
    }>;

export type AcpAuthenticationStartupErrorCode =
  | 'ACP_AUTHENTICATION_RESOLUTION_FAILED'
  | 'ACP_AUTHENTICATION_METHOD_INVALID'
  | 'ACP_AUTHENTICATION_METHOD_NOT_ADVERTISED';

export type AcpAuthenticationResolverPublicErrorOptions = Readonly<{
  /** Provider-owned stable code safe to expose in startup diagnostics. */
  code: string;
  /** Provider-authored recovery guidance that is explicitly safe to expose. */
  safePublicMessage: string;
}>;

const ERROR_MESSAGES: Readonly<Record<AcpAuthenticationStartupErrorCode, string>> = {
  ACP_AUTHENTICATION_RESOLUTION_FAILED: 'ACP authentication method resolution failed',
  ACP_AUTHENTICATION_METHOD_INVALID: 'ACP authentication selected an invalid method',
  ACP_AUTHENTICATION_METHOD_NOT_ADVERTISED: 'ACP authentication selected a method the agent did not advertise',
};

export class AcpAuthenticationStartupError extends Error {
  readonly name = 'AcpAuthenticationStartupError';

  constructor(readonly code: AcpAuthenticationStartupErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

/**
 * Explicit escape hatch for provider-owned, non-secret authentication recovery
 * guidance. Arbitrary resolver errors are still replaced by the generic startup
 * error below; providers must deliberately construct this bounded public shape.
 */
export class AcpAuthenticationResolverPublicError extends Error {
  readonly name = 'AcpAuthenticationResolverPublicError';
  readonly code: string;
  readonly safePublicMessage: string;

  constructor(options: AcpAuthenticationResolverPublicErrorOptions) {
    const code = options.code.trim();
    const safePublicMessage = options.safePublicMessage.trim();
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(code) || !safePublicMessage || safePublicMessage.length > 500) {
      throw new Error('Invalid public ACP authentication recovery error');
    }
    super(safePublicMessage);
    this.code = code;
    this.safePublicMessage = safePublicMessage;
  }
}

export function resolveAcpAuthenticationSelection(params: Readonly<{
  authentication: AcpAuthentication;
  advertisedMethodIds: ReadonlySet<string>;
  initializeMeta: Readonly<Record<string, unknown>> | null;
}>): AcpAuthenticationSelection {
  const authoritativeAdvertisedMethodIds = new Set(params.advertisedMethodIds);
  let selection: AcpAuthenticationSelection;
  if (params.authentication.kind === 'static') {
    selection = params.authentication;
  } else {
    try {
      selection = params.authentication.resolve({
        advertisedMethodIds: new Set(authoritativeAdvertisedMethodIds),
        initializeMeta: params.initializeMeta,
      });
    } catch (error) {
      if (error instanceof AcpAuthenticationResolverPublicError) {
        throw error;
      }
      throw new AcpAuthenticationStartupError('ACP_AUTHENTICATION_RESOLUTION_FAILED');
    }
  }

  const methodId = typeof selection?.methodId === 'string' ? selection.methodId.trim() : '';
  if (!methodId) {
    throw new AcpAuthenticationStartupError('ACP_AUTHENTICATION_METHOD_INVALID');
  }
  if (!authoritativeAdvertisedMethodIds.has(methodId)) {
    throw new AcpAuthenticationStartupError('ACP_AUTHENTICATION_METHOD_NOT_ADVERTISED');
  }

  return {
    methodId,
    ...(selection.meta && Object.keys(selection.meta).length > 0 ? { meta: selection.meta } : {}),
  };
}
