export type AcpSessionOpenIntent =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'resume'; expectedVendorSessionId: string }>;

export type AcpBoundSessionIdentity = Readonly<{
  generation: number;
  operation: 'create' | 'resume';
  vendorSessionId: string;
}>;

export type AcpSessionIdentityPublication =
  | Readonly<{
    kind: 'persist-bound';
    persistBound: (event: AcpBoundSessionIdentity) => Promise<void>;
  }>
  | Readonly<{ kind: 'external-owner' }>
  | Readonly<{
    kind: 'runtime-only';
    reason: 'vendor-resume-unsupported';
  }>;

export type AcpOpenedSession = Readonly<{
  sessionId?: string | null;
  replay?: ReadonlyArray<unknown> | null;
}>;

type NormalizedOpenIntent =
  | Readonly<{ kind: 'create'; key: 'create' }>
  | Readonly<{ kind: 'resume'; key: string; expectedVendorSessionId: string }>;

type AcpSessionIdentityBindingErrorCode =
  | 'ACP_SESSION_IDENTITY_EMPTY_RESUME_INTENT'
  | 'ACP_SESSION_IDENTITY_EMPTY'
  | 'ACP_SESSION_IDENTITY_RESUME_MISMATCH'
  | 'ACP_SESSION_IDENTITY_INTENT_CONFLICT'
  | 'ACP_SESSION_IDENTITY_RESET_REQUIRED'
  | 'ACP_SESSION_IDENTITY_STALE_GENERATION';

export class AcpSessionIdentityBindingError extends Error {
  readonly code: AcpSessionIdentityBindingErrorCode;
  /** Only an explicit different id disproves a requested native return. */
  readonly happierNativeResumeIdentityMismatch: boolean;

  constructor(code: AcpSessionIdentityBindingErrorCode, message: string) {
    super(message);
    this.name = 'AcpSessionIdentityBindingError';
    this.code = code;
    this.happierNativeResumeIdentityMismatch = code === 'ACP_SESSION_IDENTITY_RESUME_MISMATCH';
  }
}

function normalizeVendorSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOpenIntent(intent: AcpSessionOpenIntent): NormalizedOpenIntent {
  if (intent.kind === 'create') return { kind: 'create', key: 'create' };

  const expectedVendorSessionId = normalizeVendorSessionId(intent.expectedVendorSessionId);
  if (!expectedVendorSessionId) {
    throw new AcpSessionIdentityBindingError(
      'ACP_SESSION_IDENTITY_EMPTY_RESUME_INTENT',
      'ACP resume requires a non-empty vendor session id',
    );
  }
  return {
    kind: 'resume',
    key: `resume:${expectedVendorSessionId}`,
    expectedVendorSessionId,
  };
}

export function validateAcpOpenedSessionIdentity(
  intent: AcpSessionOpenIntent,
  rawSessionId: unknown,
): string {
  const normalizedIntent = normalizeOpenIntent(intent);
  const vendorSessionId = normalizeVendorSessionId(rawSessionId);
  if (!vendorSessionId) {
    throw new AcpSessionIdentityBindingError(
      'ACP_SESSION_IDENTITY_EMPTY',
      'ACP session open returned an empty vendor session id',
    );
  }
  if (
    normalizedIntent.kind === 'resume'
    && vendorSessionId !== normalizedIntent.expectedVendorSessionId
  ) {
    throw new AcpSessionIdentityBindingError(
      'ACP_SESSION_IDENTITY_RESUME_MISMATCH',
      'ACP session load returned a different vendor session id than requested',
    );
  }
  return vendorSessionId;
}

function createStaleGenerationError(): AcpSessionIdentityBindingError {
  return new AcpSessionIdentityBindingError(
    'ACP_SESSION_IDENTITY_STALE_GENERATION',
    'ACP session open completed after the runtime generation was reset',
  );
}

export function createAcpSessionIdentityBinding(params: Readonly<{
  persistBound: (event: AcpBoundSessionIdentity) => Promise<void>;
}>) {
  let generation = 0;
  let bound: AcpBoundSessionIdentity | null = null;
  let boundResult: AcpOpenedSession | null = null;
  let published = false;
  let failedIntentKey: string | null = null;
  let active: Readonly<{
    intentKey: string;
    controller: AbortController;
    promise: Promise<Readonly<{ identity: AcpBoundSessionIdentity; result: AcpOpenedSession }>>;
  }> | null = null;

  const assertGeneration = (expectedGeneration: number): void => {
    if (generation !== expectedGeneration) throw createStaleGenerationError();
  };

  const runBoundPublication = async (
    expectedGeneration: number,
    identity: AcpBoundSessionIdentity,
    result: AcpOpenedSession,
  ): Promise<Readonly<{ identity: AcpBoundSessionIdentity; result: AcpOpenedSession }>> => {
    assertGeneration(expectedGeneration);
    if (!published) {
      await params.persistBound(identity);
      assertGeneration(expectedGeneration);
      published = true;
    }
    return { identity, result };
  };

  const open = async (openParams: Readonly<{
    intent: AcpSessionOpenIntent;
    openSession: (context: Readonly<{
      signal: AbortSignal;
      assertCurrent: () => void;
    }>) => Promise<AcpOpenedSession>;
  }>): Promise<Readonly<{ identity: AcpBoundSessionIdentity; result: AcpOpenedSession }>> => {
    const intent = normalizeOpenIntent(openParams.intent);

    if (active) {
      if (active.intentKey === intent.key) return active.promise;
      throw new AcpSessionIdentityBindingError(
        'ACP_SESSION_IDENTITY_INTENT_CONFLICT',
        'A different ACP session open intent is already in progress',
      );
    }

    if (bound) {
      const boundIntentKey = bound.operation === 'create'
        ? 'create'
        : `resume:${bound.vendorSessionId}`;
      if (boundIntentKey !== intent.key) {
        throw new AcpSessionIdentityBindingError(
          'ACP_SESSION_IDENTITY_INTENT_CONFLICT',
          'The ACP runtime generation is already bound to a different session open intent',
        );
      }
      const result = boundResult ?? { sessionId: bound.vendorSessionId };
      const operationPromise = runBoundPublication(generation, bound, result);
      active = { intentKey: intent.key, controller: new AbortController(), promise: operationPromise };
      try {
        return await operationPromise;
      } finally {
        if (active?.promise === operationPromise) active = null;
      }
    }

    if (failedIntentKey && failedIntentKey !== intent.key) {
      throw new AcpSessionIdentityBindingError(
        'ACP_SESSION_IDENTITY_RESET_REQUIRED',
        'Reset the ACP runtime after a failed session open before changing the open intent',
      );
    }

    const operationGeneration = generation;
    const controller = new AbortController();
    const operationPromise = (async () => {
      let result: AcpOpenedSession;
      try {
        result = await openParams.openSession({
          signal: controller.signal,
          assertCurrent: () => assertGeneration(operationGeneration),
        });
      } catch (error) {
        if (generation === operationGeneration) failedIntentKey = intent.key;
        throw error;
      }

      assertGeneration(operationGeneration);
      let vendorSessionId: string;
      try {
        vendorSessionId = validateAcpOpenedSessionIdentity(intent, result.sessionId);
      } catch (error) {
        failedIntentKey = intent.key;
        throw error;
      }

      const identity: AcpBoundSessionIdentity = {
        generation: operationGeneration,
        operation: intent.kind,
        vendorSessionId,
      };
      bound = identity;
      boundResult = { ...result, sessionId: vendorSessionId };
      failedIntentKey = null;
      return await runBoundPublication(operationGeneration, identity, boundResult);
    })();

    active = { intentKey: intent.key, controller, promise: operationPromise };
    try {
      return await operationPromise;
    } finally {
      if (active?.promise === operationPromise) active = null;
    }
  };

  const reset = async (): Promise<void> => {
    const previousActive = active?.promise ?? null;
    active?.controller.abort('acp-session-identity-generation-reset');
    generation += 1;
    bound = null;
    boundResult = null;
    published = false;
    failedIntentKey = null;
    active = null;
    if (previousActive) {
      await previousActive.catch(() => undefined);
    }
  };

  return {
    open,
    reset,
    getBound: (): AcpBoundSessionIdentity | null => bound,
  };
}
