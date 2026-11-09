import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import type { WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import { readWidgetActionSurfacePortV1 } from './executeWidgetInstanceActionV1.js';
import { WidgetSurfaceReadV1Schema, type WidgetSurfaceReadV1 } from './actionsV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { createWidgetAreaReadFailureV1, projectWidgetAreaReadExceptionV1 } from './widgetAreaReadFailureV1.js';

export type WidgetActionAccountScopeV1 = Readonly<{
  serverId: string;
  accountId: string;
  /** Host-owned identity aliases; absent on hosts whose routing ids are already canonical. */
  isSameServerId?: (serverId: string) => boolean;
}>;

function isWidgetActionServerInScopeV1(scope: WidgetActionAccountScopeV1, serverId: string): boolean {
  return scope.isSameServerId?.(serverId) ?? scope.serverId === serverId;
}

/** Captured Account routing is admitted before dispatch or a mounted owner's destination read. */
export function readWidgetActionAccountScopeAdmissionV1(
  deps: Pick<ActionExecutorDeps, 'widgetAccountScope'>,
  surface: WidgetSurfaceRefV1,
  context: ActionExecutorContext,
): Readonly<{ ok: true; scope: WidgetActionAccountScopeV1 }> | ActionExecuteFailure {
  const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  if (context.signal?.aborted) return failure('cancelled');
  let scope: ReturnType<NonNullable<ActionExecutorDeps['widgetAccountScope']>>;
  try { scope = deps.widgetAccountScope?.() ?? null; }
  catch { return failure('widget_scope_unavailable'); }
  if (!scope) return failure('widget_scope_unavailable');
  const contextHomeId = context.serverIdentityId ?? context.serverId;
  if (!isWidgetActionServerInScopeV1(scope, surface.serverId) || contextHomeId && !isWidgetActionServerInScopeV1(scope, contextHomeId))
    return failure('server_target_mismatch');
  if (scope.accountId !== surface.accountId && !(surface.owner.kind === 'project' && surface.artifactId || surface.owner.kind === 'workBoard'))
    return failure('account_target_mismatch');
  return { ok: true, scope };
}

/** Captured host authority admits metadata reads and instance operations alike. */
export async function readWidgetActionSurfaceAdmissionV1(
  deps: Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetSurfaceActions' | 'workBoardArtifacts' | 'homeHubArtifacts' | 'sessionBoardAction'>,
  surface: WidgetSurfaceRefV1,
  context: ActionExecutorContext,
  options?: Readonly<{ readPlacement: true }>,
): Promise<Readonly<{ ok: true; read: WidgetSurfaceReadV1 | null }> | ActionExecuteFailure> {
  const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  const account = readWidgetActionAccountScopeAdmissionV1(deps, surface, context);
  if (!account.ok) return account;
  const { scope } = account;
  if (options?.readPlacement || surface.owner.kind === 'project' || surface.owner.kind === 'workBoard'
    || surface.owner.kind === 'pluginArea' || surface.owner.kind === 'corePage') {
    const port = readWidgetActionSurfacePortV1(deps, surface);
    if (!port) return failure('unsupported_widget_surface');
    const isAccountCurrent = () => {
      try {
        const current = deps.widgetAccountScope?.();
        return !!current && current.serverId === scope.serverId && current.accountId === scope.accountId;
      } catch { return false; }
    };
    try {
      const admitted = await port.read(surface, context, context.signal);
      if ('ok' in admitted) return admitted;
      const parsed = WidgetSurfaceReadV1Schema.safeParse(admitted);
      if (!parsed.success || !sameStrictJsonValue(parsed.data.surface, surface)) return createWidgetAreaReadFailureV1('invalid_action_output');
      if (context.signal?.aborted) return failure('cancelled');
      if (!isAccountCurrent()) return failure('widget_scope_unavailable');
      return { ok: true, read: parsed.data };
    } catch (error) {
      if (context.signal?.aborted) return failure('cancelled');
      // A failed surface read does not establish that its Account authority changed.
      // Recheck that authority before distinguishing a retryable layout read failure.
      return isAccountCurrent() ? projectWidgetAreaReadExceptionV1(error) : failure('widget_scope_unavailable');
    }
  }
  return { ok: true, read: null };
}

export async function admitWidgetActionSurfaceV1(
  deps: Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetSurfaceActions' | 'workBoardArtifacts'>,
  surface: WidgetSurfaceRefV1,
  context: ActionExecutorContext,
): Promise<ActionExecuteFailure | null> {
  const admitted = await readWidgetActionSurfaceAdmissionV1(deps, surface, context);
  return admitted.ok ? null : admitted;
}
