import { INTERNAL_ONLY_RPC_METHODS, validateInternalOnlyRpcMethodEntries, type InternalOnlyRpcMethodEntry } from '../../../../apps/cli/src/rpc/handlers/_internalAllowlist.ts';
import {
  ACTION_SPECS,
  MACHINE_RPC_ROUTE_POLICIES,
  type MachineRpcRoutePolicyV1,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type RpcActionCoverageActionSpec = Readonly<{
  id: string;
  surfaces?: Readonly<{ rpc?: boolean }>;
  bindings?: Readonly<{ rpcMethod?: string; rpcMethodAliases?: readonly string[] }>;
}>;

export type RpcActionCoverageFindingCode =
  | 'invalid-internal-only-entry'
  | 'internal-only-method-not-registered'
  | 'action-rpc-method-missing-binding'
  | 'action-rpc-method-not-registered'
  | 'duplicate-action-rpc-method'
  | 'rpc-method-conflicting-classification'
  | 'rpc-method-missing-route-policy'
  | 'route-policy-method-not-registered'
  | 'duplicate-route-policy-method'
  | 'route-policy-server-required-missing-reason'
  | 'route-policy-governance-mismatch'
  | 'route-policy-direct-unclassified'
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
  machineRpcRoutePolicies?: readonly Pick<
    MachineRpcRoutePolicyV1,
    'method' | 'routeClass' | 'serverRequiredReason' | 'rpcClassification' | 'actionSpecId'
  >[];
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

function registerActionBoundMethod(input: Readonly<{
  actionBoundByMethod: Map<string, string>;
  registeredMethodSet: ReadonlySet<string>;
  errors: RpcActionCoverageFinding[];
  spec: RpcActionCoverageActionSpec;
  method: string;
}>): void {
  if (!input.registeredMethodSet.has(input.method)) {
    pushError(input.errors, {
      code: 'action-rpc-method-not-registered',
      actionId: input.spec.id,
      method: input.method,
      message: `RPC-surfaced ActionSpec binds an unregistered RPC method: ${input.spec.id} -> ${input.method}`,
    });
  }
  const existingActionId = input.actionBoundByMethod.get(input.method);
  if (existingActionId) {
    pushError(input.errors, {
      code: 'duplicate-action-rpc-method',
      actionId: input.spec.id,
      method: input.method,
      message: `RPC method is bound by multiple ActionSpecs: ${input.method} (${existingActionId}, ${input.spec.id})`,
    });
    return;
  }
  input.actionBoundByMethod.set(input.method, input.spec.id);
}

export function validateRpcActionCoverage(
  options: ValidateRpcActionCoverageOptions = {},
): RpcActionCoverageReport {
  const registeredMethods = collectRegisteredRpcMethods(options);
  const registeredMethodSet = new Set(registeredMethods);
  const actionSpecs = options.actionSpecs ?? ACTION_SPECS;
  const internalOnlyEntries = options.internalOnlyEntries ?? INTERNAL_ONLY_RPC_METHODS;
  const usesDefaultRpcInventory = !options.rpcMethods && !options.sessionRpcMethods;
  const machineRpcRoutePolicies = options.machineRpcRoutePolicies ?? (
    usesDefaultRpcInventory ? MACHINE_RPC_ROUTE_POLICIES : []
  );
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
    registerActionBoundMethod({
      actionBoundByMethod,
      registeredMethodSet,
      errors,
      spec,
      method,
    });
    for (const alias of spec.bindings?.rpcMethodAliases ?? []) {
      const normalizedAlias = normalizeMethod(alias);
      if (!normalizedAlias) continue;
      registerActionBoundMethod({
        actionBoundByMethod,
        registeredMethodSet,
        errors,
        spec,
        method: normalizedAlias,
      });
    }
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

  const routePolicyMethods = new Set<string>();
  for (const policy of machineRpcRoutePolicies) {
    const method = normalizeMethod(policy.method);
    if (!method) {
      continue;
    }
    if (routePolicyMethods.has(method)) {
      pushError(errors, {
        code: 'duplicate-route-policy-method',
        method,
        message: `Machine RPC route policy method is declared more than once: ${method}`,
      });
    }
    routePolicyMethods.add(method);
    const isRegisteredRoutePolicyMethod = registeredMethodSet.has(method);
    if (!isRegisteredRoutePolicyMethod) {
      pushError(errors, {
        code: 'route-policy-method-not-registered',
        method,
        message: `Machine RPC route policy references an unregistered RPC method: ${method}`,
      });
    }
    if (!isRegisteredRoutePolicyMethod) {
      continue;
    }
    if (policy.routeClass === 'server_required' && !policy.serverRequiredReason) {
      pushError(errors, {
        code: 'route-policy-server-required-missing-reason',
        method,
        message: `Server-required Machine RPC route policy lacks a stable reason: ${method}`,
      });
    }
    if (policy.routeClass !== 'server_required' && policy.rpcClassification === 'advisory_unclassified') {
      pushError(errors, {
        code: 'route-policy-direct-unclassified',
        method,
        message: `Direct Machine RPC route policy must not carry advisory/unclassified governance: ${method}`,
      });
    }
    const actionId = actionBoundByMethod.get(method);
    const isInternalOnlyMethod = internalOnlyMethods.has(method);
    if (policy.rpcClassification === 'internal_only' && !isInternalOnlyMethod) {
      pushError(errors, {
        code: 'route-policy-governance-mismatch',
        method,
        message: `Machine RPC route policy self-labels internal-only without a canonical allowlist entry: ${method}`,
      });
    }
    if (
      policy.rpcClassification === 'action_spec_bound'
      && (!actionId || policy.actionSpecId !== actionId)
    ) {
      pushError(errors, {
        code: 'route-policy-governance-mismatch',
        ...(actionId ? { actionId } : {}),
        method,
        message: `Machine RPC route policy declares ActionSpec governance without matching binding metadata: ${method}`,
      });
    }
    if (actionId && isInternalOnlyMethod) {
      continue;
    }
    if (actionId) {
      if (policy.rpcClassification !== 'action_spec_bound' || policy.actionSpecId !== actionId) {
        pushError(errors, {
          code: 'route-policy-governance-mismatch',
          actionId,
          method,
          message: `Machine RPC route policy must identify ActionSpec binding metadata: ${method} -> ${actionId}`,
        });
      }
      continue;
    }
    if (isInternalOnlyMethod) {
      if (policy.rpcClassification !== 'internal_only') {
        pushError(errors, {
          code: 'route-policy-governance-mismatch',
          method,
          message: `Machine RPC route policy must identify internal-only governance metadata: ${method}`,
        });
      }
      continue;
    }
    if (
      policy.routeClass !== 'server_required'
      && policy.rpcClassification !== 'advisory_unclassified'
      && policy.rpcClassification !== 'internal_only'
      && policy.rpcClassification !== 'action_spec_bound'
    ) {
      pushError(errors, {
        code: 'route-policy-governance-mismatch',
        method,
        message: `Direct Machine RPC route policy lacks canonical ActionSpec or internal-only governance: ${method}`,
      });
    }
  }

  for (const method of registeredMethods) {
    if (!routePolicyMethods.has(method)) {
      pushError(errors, {
        code: 'rpc-method-missing-route-policy',
        method,
        message: `RPC method lacks a Machine RPC route policy row: ${method}`,
      });
    }
  }

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
