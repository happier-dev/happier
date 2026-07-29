import { createHash } from 'node:crypto';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import {
  evaluateTargetActionPolicy,
  type NormalizedTargetActionPolicy,
  type TargetActionAuthorizationFacts,
} from '../policy/evaluate';
import type { PluginInvocationServiceBinding } from './services/types';

export type TargetActionExecutionResult = Readonly<
  | { status: 'executed'; value: JsonValue | null }
  | { status: 'unavailable' | 'invalid' | 'failed'; code: string; message: string }
>;

export type ResolvedTargetAction = NormalizedTargetActionPolicy & Readonly<{
  pluginId: string;
  localId: string;
  input: unknown;
  accountId?: string;
  resourceId?: string;
  policyFingerprint: string;
}>;

export type TargetActionCurrentIntentRequest = Readonly<{
  action: ResolvedTargetAction;
  fingerprint: string;
  surface: string;
  signal?: AbortSignal;
}>;

export type TargetActionCurrentIntentResult = Readonly<
  | { status: 'approved'; fingerprint: string }
  | { status: 'rejected' | 'unavailable'; code: string }
>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function fingerprintTargetActionIntent(action: ResolvedTargetAction, surface: string): string {
  return createHash('sha256').update(stable({
    qualifiedId: action.qualifiedId, input: action.input, accountId: action.accountId,
    resourceId: action.resourceId, generation: action.generation,
    policyFingerprint: action.policyFingerprint, surface,
  })).digest('hex');
}

export function fingerprintTargetActionPolicy(action: NormalizedTargetActionPolicy): string {
  return createHash('sha256').update(stable({
    qualifiedId: action.qualifiedId,
    generation: action.generation,
    dangerLevel: action.dangerLevel,
    scopes: action.scopes,
    surfaces: action.surfaces,
    hostAccess: action.hostAccess,
    availability: action.availability,
    confirmation: action.confirmation,
  })).digest('hex');
}

function unavailable(code: string): TargetActionExecutionResult {
  return Object.freeze({ status: 'unavailable', code, message: code });
}

function failed(code: string, error: unknown): TargetActionExecutionResult {
  return Object.freeze({
    status: 'failed',
    code,
    message: error instanceof Error ? error.message : code,
  });
}

function isCurrentServiceBinding(
  action: ResolvedTargetAction,
  serviceBinding: PluginInvocationServiceBinding,
): boolean {
  return serviceBinding.generation === action.generation;
}

function bindResolvedPolicy(action: ResolvedTargetAction): ResolvedTargetAction {
  return Object.freeze({
    ...action,
    policyFingerprint: fingerprintTargetActionPolicy(action),
  });
}

export function createTargetActionExecutor(deps: Readonly<{
  resolve: (args: Readonly<{ pluginId: string; localId: string; input: unknown }>) => ResolvedTargetAction | null;
  resolveAuthorizationFacts: (action: ResolvedTargetAction) => TargetActionAuthorizationFacts;
  resolveHostBinding: (action: ResolvedTargetAction) => Promise<Readonly<{
    action: ResolvedTargetAction;
    serviceBinding: PluginInvocationServiceBinding;
  }> | null>;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  fingerprint?: (action: ResolvedTargetAction, surface: string) => string;
  invoke: (action: ResolvedTargetAction, args: Readonly<{ surface: string; sessionId?: string; signal?: AbortSignal }>, serviceBinding: PluginInvocationServiceBinding) => Promise<TargetActionExecutionResult>;
  diagnostic?: (fact: Readonly<{ qualifiedId: string; generation: string; surface: string; status: string; code?: string }>) => void | Promise<void>;
}>) {
  return Object.freeze({
    async execute(args: Readonly<{ pluginId: string; localId: string; input: unknown; surface: string; sessionId?: string; signal?: AbortSignal; requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> }>): Promise<TargetActionExecutionResult> {
      let action = deps.resolve(args);
      let serviceBinding: PluginInvocationServiceBinding | null = null;
      const finish = async (result: TargetActionExecutionResult): Promise<TargetActionExecutionResult> => {
        try {
          await deps.diagnostic?.({
            qualifiedId: action?.qualifiedId ?? `${args.pluginId}/actions/${args.localId}`,
            generation: action?.generation ?? 'unavailable',
            surface: args.surface, status: result.status, ...('code' in result ? { code: result.code } : {}),
          });
        } catch { /* Diagnostics are failure-isolated from authorization and execution. */ }
        return result;
      };
      if (!action) return await finish(unavailable('plugin_action_handler_missing'));
      try {
        const binding = await deps.resolveHostBinding(action);
        action = binding ? bindResolvedPolicy(binding.action) : null;
        serviceBinding = binding?.serviceBinding ?? null;
      } catch (error) {
        return await finish(failed(
          error instanceof PluginError ? error.code : 'plugin_action_selection_failed',
          error,
        ));
      }
      if (!action || !serviceBinding) return await finish(unavailable('plugin_action_selection_unavailable'));
      if (!isCurrentServiceBinding(action, serviceBinding)) return await finish(unavailable('plugin_action_generation_retired'));
      const evaluate = () => evaluateTargetActionPolicy({
        action: action!,
        authorizationFacts: deps.resolveAuthorizationFacts(action!),
        surface: args.surface,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      });
      let policy = evaluate();
      if (policy.outcome !== 'visible') return await finish(unavailable(policy.code));
      if (policy.requiresCurrentIntent) {
        const requestCurrentIntent = args.requestCurrentIntent ?? deps.requestCurrentIntent;
        if (!requestCurrentIntent) return await finish(unavailable('plugin_action_current_intent_unavailable'));
        const fingerprint = (deps.fingerprint ?? fingerprintTargetActionIntent)(action, args.surface);
        let intent: TargetActionCurrentIntentResult;
        try {
          intent = await requestCurrentIntent({ action, fingerprint, surface: args.surface, ...(args.signal ? { signal: args.signal } : {}) });
        } catch (error) {
          return await finish(args.signal?.aborted
            ? unavailable('plugin_action_aborted')
            : unavailable('plugin_action_current_intent_unavailable'));
        }
        if (args.signal?.aborted) return await finish(unavailable('plugin_action_aborted'));
        if (intent.status !== 'approved') return await finish(unavailable(intent.code));
        if (intent.fingerprint !== fingerprint) return await finish(unavailable('plugin_action_current_intent_mismatch'));
        action = deps.resolve(args);
        if (!action) return await finish(unavailable('plugin_action_handler_missing'));
        try {
          const binding = await deps.resolveHostBinding(action);
          action = binding ? bindResolvedPolicy(binding.action) : null;
          serviceBinding = binding?.serviceBinding ?? null;
        } catch (error) {
          return await finish(failed(
            error instanceof PluginError ? error.code : 'plugin_action_selection_failed',
            error,
          ));
        }
        if (!action || !serviceBinding) return await finish(unavailable('plugin_action_selection_unavailable'));
        if (!isCurrentServiceBinding(action, serviceBinding)) return await finish(unavailable('plugin_action_generation_retired'));
        const currentFingerprint = (deps.fingerprint ?? fingerprintTargetActionIntent)(action, args.surface);
        if (currentFingerprint !== fingerprint) return await finish(unavailable('plugin_action_current_intent_mismatch'));
        policy = evaluate();
        if (policy.outcome !== 'visible') return await finish(unavailable(policy.code));
      }
      if (args.signal?.aborted) return await finish(unavailable('plugin_action_aborted'));
      let result: TargetActionExecutionResult;
      try {
        result = await deps.invoke(action, { surface: args.surface, ...(args.sessionId ? { sessionId: args.sessionId } : {}), ...(args.signal ? { signal: args.signal } : {}) }, serviceBinding);
      } catch (error) {
        result = failed('plugin_action_execution_failed', error);
      }
      return await finish(result);
    },
  });
}
