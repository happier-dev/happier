import type { Settings } from '@/sync/domains/settings/settings';

type VoiceQaTemporarySettingsScopeDependencies = Readonly<{
  readSettings: () => Settings;
  applySettingsLocal: (delta: Partial<Settings>) => void;
}>;

type VoiceQaTemporarySettingsScopeRequest = Readonly<{
  ownerId: string;
  delta: Partial<Settings>;
  signal?: AbortSignal | null;
}>;

type ActiveSettingsScope = {
  token: symbol;
  ownerId: string;
  delta: Partial<Settings>;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
};

export type VoiceQaTemporarySettingsScopeCoordinator = Readonly<{
  run: <T>(
    request: VoiceQaTemporarySettingsScopeRequest,
    action: () => Promise<T>,
  ) => Promise<T>;
  releaseOwner: (ownerId: string) => void;
}>;

export function createVoiceQaTemporarySettingsScopeCoordinator(
  dependencies: VoiceQaTemporarySettingsScopeDependencies,
): VoiceQaTemporarySettingsScopeCoordinator {
  const baselineByKey = new Map<keyof Settings, Settings[keyof Settings]>();
  const activeScopes: ActiveSettingsScope[] = [];

  const captureBaseline = (delta: Partial<Settings>) => {
    const settings = dependencies.readSettings();
    for (const key of Object.keys(delta) as Array<keyof Settings>) {
      if (!baselineByKey.has(key)) {
        baselineByKey.set(key, settings[key]);
      }
    }
  };

  const detachAbortListener = (scope: ActiveSettingsScope) => {
    if (!scope.abortListener) return;
    scope.signal?.removeEventListener('abort', scope.abortListener);
    scope.abortListener = null;
  };

  const applyActiveProjection = () => {
    if (baselineByKey.size === 0) return;
    const projection: Record<string, unknown> = {};
    for (const [key, value] of baselineByKey) {
      projection[String(key)] = value;
    }
    for (const scope of activeScopes) {
      Object.assign(projection, scope.delta);
    }
    dependencies.applySettingsLocal(projection as Partial<Settings>);
    if (activeScopes.length === 0) {
      baselineByKey.clear();
    }
  };

  const releaseScope = (token: symbol) => {
    const index = activeScopes.findIndex((scope) => scope.token === token);
    if (index < 0) return;
    const [scope] = activeScopes.splice(index, 1);
    if (scope) detachAbortListener(scope);
    applyActiveProjection();
  };

  const acquireScope = (request: VoiceQaTemporarySettingsScopeRequest): (() => void) => {
    captureBaseline(request.delta);
    const scope: ActiveSettingsScope = {
      token: Symbol('voiceQaTemporarySettingsScope'),
      ownerId: request.ownerId,
      delta: request.delta,
      signal: request.signal ?? null,
      abortListener: null,
    };
    activeScopes.push(scope);
    try {
      dependencies.applySettingsLocal(request.delta);
    } catch (error) {
      const index = activeScopes.findIndex((candidate) => candidate.token === scope.token);
      if (index >= 0) activeScopes.splice(index, 1);
      applyActiveProjection();
      throw error;
    }

    scope.abortListener = () => {
      releaseScope(scope.token);
    };
    scope.signal?.addEventListener('abort', scope.abortListener, { once: true });
    if (scope.signal?.aborted) {
      releaseScope(scope.token);
    }
    return () => releaseScope(scope.token);
  };

  return {
    run: async (request, action) => {
      const release = acquireScope(request);
      try {
        return await action();
      } finally {
        release();
      }
    },
    releaseOwner: (ownerId) => {
      const released = activeScopes.filter((scope) => scope.ownerId === ownerId);
      if (released.length === 0) return;
      for (const scope of released) {
        detachAbortListener(scope);
      }
      for (let index = activeScopes.length - 1; index >= 0; index -= 1) {
        if (activeScopes[index]?.ownerId === ownerId) {
          activeScopes.splice(index, 1);
        }
      }
      applyActiveProjection();
    },
  };
}
