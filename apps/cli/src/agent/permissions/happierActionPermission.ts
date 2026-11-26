import type { ActionId, ActionExecutorContext, ActionExecuteResult } from '@happier-dev/protocol';
import { ActionDefinitionV1Schema, type ActionDefinitionV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { findActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readActionSessionTargetField } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { normalizeSessionTargetV1, type ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { parseSessionPermissionModeAlias } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import type { PermissionMode } from '@/api/types';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import { resolveCausalPermissionMode } from './causalPermissionMode';

const PLAN_REVERSIBLE_SESSION_ACTION_IDS: ReadonlySet<string> = new Set([
  'session.mode.set',
  'session.goal.set',
  'session.goal.clear',
]);

function hasHappierActionEffectCeiling(permissionMode: PermissionMode): boolean {
  return permissionMode === 'read-only' || permissionMode === 'plan';
}

function targetsCallerSession(
  input: unknown,
  targetField: string,
  caller: ActionSessionAddressV1,
  defaultSessionId: string | null | undefined,
): boolean {
  const operand = readActionSessionTargetField(readRecord(input), targetField);
  if (operand === undefined) return defaultSessionId === caller.sessionId;

  try {
    const target = normalizeSessionTargetV1(operand);
    if (typeof target === 'string') return target === caller.sessionId;
    if (target.selector === 'self') return (target.of ?? defaultSessionId) === caller.sessionId;
    if (target.selector === 'sessions' && target.addresses.length === 1) {
      const [address] = target.addresses;
      return address?.sessionId === caller.sessionId && address.serverId === caller.serverId;
    }
    return false;
  } catch {
    return false;
  }
}

/** Action effects enforce the ceiling; ordinary confirmation stays with the Action executor. */
export type HappierActionPermissionResult =
  | Readonly<{ decision: 'approved' }>
  | Readonly<{ decision: 'denied'; reasonCode: 'permission_exceeds_ceiling'; rationale: string }>;

export function resolveHappierActionPermission(params: Readonly<{
  spec: Pick<ActionDefinitionV1, 'id' | 'sideEffectClass' | 'sessionTarget'>;
  permissionMode: PermissionMode;
  input: unknown;
  callerSession?: ActionSessionAddressV1;
  defaultSessionId?: string | null;
}>): HappierActionPermissionResult {
  const planModeSelfControl = params.permissionMode === 'plan'
    && PLAN_REVERSIBLE_SESSION_ACTION_IDS.has(params.spec.id)
    && params.callerSession
    && params.spec.sessionTarget
    && targetsCallerSession(params.input, params.spec.sessionTarget.field, params.callerSession, params.defaultSessionId);
  return hasHappierActionEffectCeiling(params.permissionMode)
    && !planModeSelfControl
    && params.spec.sideEffectClass !== 'none'
    && params.spec.sideEffectClass !== 'read'
    ? {
        decision: 'denied',
        reasonCode: 'permission_exceeds_ceiling',
        rationale: `permission_exceeds_ceiling: This Action is unavailable in ${params.permissionMode} mode.`,
      }
    : { decision: 'approved' };
}

type ActionPermissionWitness = Pick<AcpPermissionCallContext, 'causalPermissionAuthority' | 'callerPermissionMode'>;

/** Execution backstop for Agents that can reach Happier tools without a native permission offer. */
function resolveHappierActionIngressMode(
  currentMode: string | null,
  witness: ActionPermissionWitness | null,
): PermissionMode {
  const currentPermissionMode = parseSessionPermissionModeAlias(currentMode ?? '')
    ?? parseSessionPermissionModeAlias(witness?.callerPermissionMode ?? '')
    ?? 'default';
  if (!witness?.causalPermissionAuthority) return currentPermissionMode;
  const effective = resolveCausalPermissionMode({
    currentPermissionMode,
    context: {
      causalPermissionAuthority: witness.causalPermissionAuthority,
      ...(witness.callerPermissionMode ? { callerPermissionMode: witness.callerPermissionMode } : {}),
    },
  });
  return effective.ok ? effective.effectiveMode : currentPermissionMode;
}

export function createHappierActionIngressExecutor(params: Readonly<{
  executor: { execute(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult> };
  readPermission(): Readonly<{ mode: string | null; witness: ActionPermissionWitness | null }>;
  callerSession?: ActionSessionAddressV1;
}>) {
  return {
    async execute(actionId: ActionId, input: unknown, context?: ActionExecutorContext, definition?: ActionDefinitionV1): Promise<ActionExecuteResult> {
      const { mode, witness } = params.readPermission();
      const permissionMode = resolveHappierActionIngressMode(mode, witness);
      if (hasHappierActionEffectCeiling(permissionMode)) {
        let spec = definition ?? findActionSpec(actionId);
        if (!spec && parseQualifiedPluginActionId(actionId)) {
          const discovery = await params.executor.execute('action.spec.get', { id: actionId }, context);
          if (!discovery.ok) return discovery;
          const result = discovery.result;
          const parsed = ActionDefinitionV1Schema.safeParse(
            result && typeof result === 'object' && 'actionSpec' in result ? result.actionSpec : undefined,
          );
          if (!parsed.success || parsed.data.id !== actionId) {
            return { ok: false, errorCode: 'action_disabled', error: 'Action is unavailable' };
          }
          spec = parsed.data;
        }
        if (spec) {
          const decision = resolveHappierActionPermission({
            spec, permissionMode, input, callerSession: params.callerSession, defaultSessionId: context?.defaultSessionId,
          });
          if (decision.decision === 'denied') {
            return { ok: false, errorCode: decision.reasonCode, error: decision.rationale };
          }
        }
      }
      return await params.executor.execute(actionId, input, context);
    },
  };
}
