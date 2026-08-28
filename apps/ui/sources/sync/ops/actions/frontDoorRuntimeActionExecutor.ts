import type { ActionId, RuntimeActionExecute } from '@happier-dev/protocol';

import type { createDefaultActionExecutor } from './defaultActionExecutor';

type ActionExecutorLike = Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;

/**
 * The canonical `ActionExecutor.execute` front door, lazily resolved.
 *
 * Unlike {@link createFrontDoorRuntimeActionExecutor} this preserves the
 * discriminated `ActionExecuteResult`, so a caller that must distinguish success
 * from failure — the plugin-surface action dispatcher, which rejects failures as
 * typed public errors — is not handed a collapsed value it would have to
 * re-inspect (UI-D08).
 */
export function createFrontDoorActionExecute(
  executor?: ActionExecutorLike,
): ActionExecutorLike['execute'] {
  // Lazily resolve the default executor on first dispatch so that mounting a surface (which often
  // renders nothing) never eagerly builds the full executor dependency graph.
  let resolved: ActionExecutorLike | null = executor ?? null;
  return async (actionId, input, context) => {
    const target = resolved ?? (resolved = (await import('./defaultActionExecutor')).createDefaultActionExecutor());
    return target.execute(actionId, input, context);
  };
}

/**
 * Product-UI adapter for existing domain clients whose leaf contract is
 * `(actionId, input) => value`. Policy, approval, provenance and failure
 * settlement remain owned by the one Action front door; HTTP executors stay
 * below `createDefaultActionExecutor` as transport dependencies only.
 */
export function createFrontDoorUiActionExecutor(
  executor?: ActionExecutorLike,
): (
  actionId: ActionId,
  input: unknown,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown> {
  const execute = createFrontDoorActionExecute(executor);
  return async (actionId, input, options) => {
    const result = await execute(actionId, input, {
      surface: 'ui',
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.result;
  };
}

/**
 * Canonical front-door bridge: adapts `ActionExecutor.execute` into the `RuntimeActionExecute`
 * shape that runtime-action consumers (local-services panes, browser-panel host API) depend on.
 *
 * This is the single, sanctioned `runtimeActionExecute` adapter (FINALIZATION-PLAN §2.3/§12.6):
 * every product runtime-action dispatch flows through `ActionExecutor.execute`, so per-surface
 * enablement (ActionsSettings) and approval routing (§4.2/§12.8 agent-approval defaults) are
 * always enforced. Product surfaces must obtain their runtime dispatcher here and never call the
 * raw `createDefaultRuntimeActionExecutor` (which is only the executor's internal dep).
 *
 * On success the raw runtime result is unwrapped so callers keep parsing the same payloads they
 * received from the legacy direct path; on failure the `{ ok: false, errorCode, error }` envelope
 * is returned verbatim, which callers treat as fail-closed (schema parse rejects it).
 */
export function createFrontDoorRuntimeActionExecutor(
  executor?: ActionExecutorLike,
): RuntimeActionExecute {
  const execute = createFrontDoorActionExecute(executor);
  return async ({ actionId, input, context }) => {
    const result = await execute(actionId, input, context);
    return result.ok ? result.result : result;
  };
}
