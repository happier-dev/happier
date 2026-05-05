import { INTERNAL_ONLY_RPC_METHODS, validateInternalOnlyRpcMethodEntries, type InternalOnlyRpcMethodEntry } from '../../../../apps/cli/src/rpc/handlers/_internalAllowlist.ts';
import { ACTION_SPECS } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type RpcActionCoverageActionSpec = Readonly<{
  id: string;
  surfaces?: Readonly<{ rpc?: boolean }>;
  bindings?: Readonly<{ rpcMethod?: string }>;
}>;

export type RpcActionCoverageFindingCode =
  | 'invalid-internal-only-entry'
  | 'internal-only-method-not-registered'
  | 'action-rpc-method-missing-binding'
  | 'action-rpc-method-not-registered'
  | 'duplicate-action-rpc-method'
  | 'rpc-method-conflicting-classification'
  | 'unclassified-rpc-method';

export type RpcActionCoverageFinding = Readonly<{
  severity: 'error' | 'warning';
  code: RpcActionCoverageFindingCode;
  method?: string;
  actionId?: string;
  message: string;
}>;

export type RpcActionCoverageReport = Readonly<{
  ok: boolean;
  errors: readonly RpcActionCoverageFinding[];
  warnings: readonly RpcActionCoverageFinding[];
  registeredRpcMethods: readonly string[];
  actionBoundRpcMethods: readonly string[];
  internalOnlyRpcMethods: readonly string[];
  unclassifiedRpcMethods: readonly string[];
}>;

export type ValidateRpcActionCoverageOptions = Readonly<{
  rpcMethods?: Readonly<Record<string, string>>;
  sessionRpcMethods?: Readonly<Record<string, string>>;
  actionSpecs?: readonly RpcActionCoverageActionSpec[];
  internalOnlyEntries?: readonly InternalOnlyRpcMethodEntry[];
}>;

function normalizeMethod(value: string): string {
  return value.trim();
}

function collectRegisteredRpcMethods(options: ValidateRpcActionCoverageOptions): readonly string[] {
  return Array.from(new Set([
    ...Object.values(options.rpcMethods ?? RPC_METHODS),
    ...Object.values(options.sessionRpcMethods ?? SESSION_RPC_METHODS),
  ].map(normalizeMethod).filter(Boolean))).sort();
}

function pushError(
  errors: RpcActionCoverageFinding[],
  finding: Omit<RpcActionCoverageFinding, 'severity'>,
): void {
  errors.push({ severity: 'error', ...finding });
}

function pushWarning(
  warnings: RpcActionCoverageFinding[],
  finding: Omit<RpcActionCoverageFinding, 'severity'>,
): void {
  warnings.push({ severity: 'warning', ...finding });
}

export function validateRpcActionCoverage(
  options: ValidateRpcActionCoverageOptions = {},
): RpcActionCoverageReport {
  const registeredMethods = collectRegisteredRpcMethods(options);
  const registeredMethodSet = new Set(registeredMethods);
  const actionSpecs = options.actionSpecs ?? ACTION_SPECS;
  const internalOnlyEntries = options.internalOnlyEntries ?? INTERNAL_ONLY_RPC_METHODS;
  const errors: RpcActionCoverageFinding[] = [];
  const warnings: RpcActionCoverageFinding[] = [];
  const actionBoundByMethod = new Map<string, string>();

  const internalOnlyValidation = validateInternalOnlyRpcMethodEntries(internalOnlyEntries);
  for (const error of internalOnlyValidation.errors) {
    pushError(errors, {
      code: 'invalid-internal-only-entry',
      ...(error.method ? { method: error.method } : {}),
      message: error.message,
    });
  }

  for (const spec of actionSpecs) {
    if (spec.surfaces?.rpc !== true) {
      continue;
    }
    const method = normalizeMethod(spec.bindings?.rpcMethod ?? '');
    if (!method) {
      pushError(errors, {
        code: 'action-rpc-method-missing-binding',
        actionId: spec.id,
        message: `RPC-surfaced ActionSpec lacks bindings.rpcMethod: ${spec.id}`,
      });
      continue;
    }
    if (!registeredMethodSet.has(method)) {
      pushError(errors, {
        code: 'action-rpc-method-not-registered',
        actionId: spec.id,
        method,
        message: `RPC-surfaced ActionSpec binds an unregistered RPC method: ${spec.id} -> ${method}`,
      });
    }
    const existingActionId = actionBoundByMethod.get(method);
    if (existingActionId) {
      pushError(errors, {
        code: 'duplicate-action-rpc-method',
        actionId: spec.id,
        method,
        message: `RPC method is bound by multiple ActionSpecs: ${method} (${existingActionId}, ${spec.id})`,
      });
      continue;
    }
    actionBoundByMethod.set(method, spec.id);
  }

  const internalOnlyMethods = new Set<string>();
  for (const entry of internalOnlyEntries) {
    const method = normalizeMethod(entry.method);
    if (!method) {
      continue;
    }
    internalOnlyMethods.add(method);
    if (!registeredMethodSet.has(method)) {
      pushError(errors, {
        code: 'internal-only-method-not-registered',
        method,
        message: `Internal-only RPC method is not registered in RPC_METHODS or SESSION_RPC_METHODS: ${method}`,
      });
    }
    const actionId = actionBoundByMethod.get(method);
    if (actionId) {
      pushError(errors, {
        code: 'rpc-method-conflicting-classification',
        actionId,
        method,
        message: `RPC method cannot be both action-bound and internal-only: ${method}`,
      });
    }
  }

  const actionBoundMethods = new Set(actionBoundByMethod.keys());
  const unclassifiedMethods = registeredMethods.filter((method) => (
    !actionBoundMethods.has(method) && !internalOnlyMethods.has(method)
  ));

  for (const method of unclassifiedMethods) {
    pushWarning(warnings, {
      code: 'unclassified-rpc-method',
      method,
      message: `RPC method is not yet classified as ActionSpec-backed or internal-only: ${method}`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    registeredRpcMethods: registeredMethods,
    actionBoundRpcMethods: Array.from(actionBoundMethods).sort(),
    internalOnlyRpcMethods: Array.from(internalOnlyMethods).sort(),
    unclassifiedRpcMethods: unclassifiedMethods,
  };
}
