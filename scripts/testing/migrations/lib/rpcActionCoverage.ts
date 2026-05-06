import { INTERNAL_ONLY_RPC_METHODS, validateInternalOnlyRpcMethodEntries, type InternalOnlyRpcMethodEntry } from '../../../../apps/cli/src/rpc/handlers/_internalAllowlist.ts';
import {
  ACTION_SPEC_RPC_EXCEPTIONS,
  ACTION_SPEC_RPC_EXCEPTION_REASONS,
  type ActionSpecRpcException,
} from '../../../../apps/cli/src/rpc/handlers/actionSpecRpcExceptions.ts';
import {
  collectActionSpecRpcMethodsForScopes,
  isActionSpecRpcSpecInScopes,
  REQUIRED_GENERIC_ACTION_SPEC_RPC_SCOPES,
} from '../../../../apps/cli/src/rpc/handlers/actionSpecRpcRegistration.ts';
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
  | 'action-rpc-method-not-generically-registered'
  | 'action-rpc-exception-generically-servable'
  | 'duplicate-action-rpc-method-coverage'
  | 'invalid-action-spec-rpc-exception'
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
  genericActionSpecRpcMethods?: readonly string[];
  actionSpecRpcExceptions?: readonly ActionSpecRpcException[];
  internalOnlyEntries?: readonly InternalOnlyRpcMethodEntry[];
  machineRpcRoutePolicies?: readonly Pick<
    MachineRpcRoutePolicyV1,
    'method' | 'routeClass' | 'serverRequiredReason' | 'rpcClassification' | 'actionSpecId'
  >[];
}>;

function normalizeMethod(value: string): string {
  return value.trim();
}

function normalizeMetadataString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

const ACTION_SPEC_RPC_EXCEPTION_REASON_SET = new Set<string>(ACTION_SPEC_RPC_EXCEPTION_REASONS);

function collectActionSpecRpcMethods(
  actionSpecs: readonly RpcActionCoverageActionSpec[],
): readonly { actionId: string; method: string }[] {
  const methods: { actionId: string; method: string }[] = [];
  for (const spec of actionSpecs) {
    if (spec.surfaces?.rpc !== true) {
      continue;
    }
    const method = normalizeMethod(spec.bindings?.rpcMethod ?? '');
    if (method) {
      methods.push({ actionId: spec.id, method });
    }
    for (const alias of spec.bindings?.rpcMethodAliases ?? []) {
      const normalizedAlias = normalizeMethod(alias);
      if (normalizedAlias) {
        methods.push({ actionId: spec.id, method: normalizedAlias });
      }
    }
  }
  return methods;
}

function collectDefaultGenericActionSpecRpcMethods(input: Readonly<{
  actionSpecs: readonly RpcActionCoverageActionSpec[];
}>): readonly string[] {
  return collectActionSpecRpcMethodsForScopes(
    input.actionSpecs,
    REQUIRED_GENERIC_ACTION_SPEC_RPC_SCOPES,
  );
}

function collectDefaultGenericActionSpecRpcActionIds(input: Readonly<{
  actionSpecs: readonly RpcActionCoverageActionSpec[];
}>): ReadonlySet<string> {
  return new Set(
    input.actionSpecs
      .filter((spec) => isActionSpecRpcSpecInScopes(spec, REQUIRED_GENERIC_ACTION_SPEC_RPC_SCOPES))
      .map((spec) => spec.id)
      .filter(Boolean),
  );
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

function validateActionSpecRpcExceptions(input: Readonly<{
  errors: RpcActionCoverageFinding[];
  exceptions: readonly ActionSpecRpcException[];
  genericMethodSet: ReadonlySet<string>;
  requiredGenericActionIds: ReadonlySet<string>;
}>): ReadonlySet<string> {
  const exceptionMethods = new Set<string>();

  for (const exception of input.exceptions) {
    const method = normalizeMethod(exception.method);
    if (!method) {
      pushError(input.errors, {
        code: 'invalid-action-spec-rpc-exception',
        message: 'ActionSpec RPC exception entries must declare a non-empty method.',
      });
      continue;
    }

    if (exceptionMethods.has(method)) {
      pushError(input.errors, {
        code: 'invalid-action-spec-rpc-exception',
        method,
        message: `ActionSpec RPC exception method is declared more than once: ${method}`,
      });
    }
    exceptionMethods.add(method);

    if (!ACTION_SPEC_RPC_EXCEPTION_REASON_SET.has(String(exception.reason))) {
      pushError(input.errors, {
        code: 'invalid-action-spec-rpc-exception',
        method,
        message: `ActionSpec RPC exception declares an invalid reason: ${method}`,
      });
    }

    if (!normalizeMetadataString(exception.ownerPacket)) {
      pushError(input.errors, {
        code: 'invalid-action-spec-rpc-exception',
        method,
        message: `ActionSpec RPC exception requires an owner packet: ${method}`,
      });
    }

    if (!normalizeMetadataString(exception.rationale)) {
      pushError(input.errors, {
        code: 'invalid-action-spec-rpc-exception',
        method,
        message: `ActionSpec RPC exception requires a rationale: ${method}`,
      });
    }

    const hasRetirement = Boolean(normalizeMetadataString(exception.retirement));
    const hasPermanence = Boolean(normalizeMetadataString(exception.permanence));
    if (!hasRetirement && !hasPermanence && exception.reason !== 'packet_owned_coordination') {
      pushError(input.errors, {
        code: 'invalid-action-spec-rpc-exception',
        method,
        message: `ActionSpec RPC exception requires a retirement condition or permanence rationale: ${method}`,
      });
    }

    if (exception.reason === 'packet_owned_coordination' && !hasRetirement) {
      pushError(input.errors, {
        code: 'invalid-action-spec-rpc-exception',
        method,
        message: `Packet-owned ActionSpec RPC coordination exception requires a retirement condition: ${method}`,
      });
    }

    if (
      (exception.actionId && input.requiredGenericActionIds.has(exception.actionId))
      || input.genericMethodSet.has(method)
    ) {
      pushError(input.errors, {
        code: 'action-rpc-exception-generically-servable',
        ...(exception.actionId ? { actionId: exception.actionId } : {}),
        method,
        message: `Required-generic ActionSpec RPC method must not be excepted from generic registration: ${method}`,
      });
    }

    if (input.genericMethodSet.has(method)) {
      pushError(input.errors, {
        code: 'duplicate-action-rpc-method-coverage',
        ...(exception.actionId ? { actionId: exception.actionId } : {}),
        method,
        message: `ActionSpec RPC method cannot be both generically registered and excepted: ${method}`,
      });
    }
  }

  return exceptionMethods;
}

export function validateRpcActionCoverage(
  options: ValidateRpcActionCoverageOptions = {},
): RpcActionCoverageReport {
  const registeredMethods = collectRegisteredRpcMethods(options);
  const registeredMethodSet = new Set(registeredMethods);
  const actionSpecs = options.actionSpecs ?? ACTION_SPECS;
  const actionSpecRpcExceptions = options.actionSpecRpcExceptions ?? ACTION_SPEC_RPC_EXCEPTIONS;
  const genericActionSpecRpcMethods = options.genericActionSpecRpcMethods ?? collectDefaultGenericActionSpecRpcMethods({
    actionSpecs,
  });
  const genericActionSpecRpcMethodSet = new Set(genericActionSpecRpcMethods.map(normalizeMethod).filter(Boolean));
  const requiredGenericActionIds = collectDefaultGenericActionSpecRpcActionIds({ actionSpecs });
  const internalOnlyEntries = options.internalOnlyEntries ?? INTERNAL_ONLY_RPC_METHODS;
  const usesDefaultRpcInventory = !options.rpcMethods && !options.sessionRpcMethods;
  const machineRpcRoutePolicies = options.machineRpcRoutePolicies ?? (
    usesDefaultRpcInventory ? MACHINE_RPC_ROUTE_POLICIES : []
  );
  const errors: RpcActionCoverageFinding[] = [];
  const warnings: RpcActionCoverageFinding[] = [];
  const actionBoundByMethod = new Map<string, string>();

  const actionSpecRpcExceptionMethods = validateActionSpecRpcExceptions({
    errors,
    exceptions: actionSpecRpcExceptions,
    genericMethodSet: genericActionSpecRpcMethodSet,
    requiredGenericActionIds,
  });

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
  for (const [method, actionId] of actionBoundByMethod) {
    if (genericActionSpecRpcMethodSet.has(method) || actionSpecRpcExceptionMethods.has(method)) {
      continue;
    }
    pushError(errors, {
      code: 'action-rpc-method-not-generically-registered',
      actionId,
      method,
      message: `RPC-surfaced ActionSpec method is not covered by generic registration or a typed exception: ${actionId} -> ${method}`,
    });
  }
  for (const exception of actionSpecRpcExceptions) {
    const method = normalizeMethod(exception.method);
    if (!method || !exception.actionId || !actionBoundByMethod.has(method)) {
      continue;
    }
    const boundActionId = actionBoundByMethod.get(method);
    if (boundActionId !== exception.actionId) {
      pushError(errors, {
        code: 'invalid-action-spec-rpc-exception',
        actionId: exception.actionId,
        method,
        message: `ActionSpec RPC exception action id does not match binding metadata: ${method}`,
      });
    }
  }
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
