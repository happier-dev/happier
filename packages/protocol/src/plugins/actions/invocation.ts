import { AgentRuntimeJsonValueV1Schema } from '../../runtime/agentSessionV1.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from './jsonSchemaValidation.js';

type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly StrictJsonValue[]
  | { readonly [key: string]: StrictJsonValue };

export type PluginActionInvocationResult = Readonly<
  | { status: 'executed'; value: StrictJsonValue | null }
  | {
    status: 'unavailable' | 'invalid' | 'failed';
    code: string;
    message: string;
  }
>;

export type PluginActionInvocationHandlerInput = Readonly<{
  input: StrictJsonValue;
  qualifiedId: string;
  signal: AbortSignal;
}>;

/**
 * A host-side admission denial after canonical input-schema validation. This
 * is intentionally an outcome rather than an exception so pre-handler
 * currentness checks cannot be misclassified as a handler failure.
 */
type PluginActionInvocationPreDispatchResult = Readonly<{
  status: 'unavailable';
  code: string;
  message: string;
}>;

const invalidInput = Object.freeze({
  status: 'invalid' as const,
  code: 'plugin_action_input_schema_invalid',
  message: 'Plugin action input does not match its manifest inputSchema',
});

function invalidResult(message: string): PluginActionInvocationResult {
  return Object.freeze({
    status: 'invalid',
    code: 'plugin_action_result_schema_invalid',
    message,
  });
}

function unavailable(code: string, message: string): PluginActionInvocationResult {
  return Object.freeze({ status: 'unavailable', code, message });
}

function readPreDispatchUnavailableResult(
  value: unknown,
): PluginActionInvocationPreDispatchResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.status !== 'unavailable'
    || typeof record.code !== 'string'
    || typeof record.message !== 'string'
  ) return null;
  return Object.freeze({
    status: 'unavailable',
    code: record.code,
    message: record.message,
  });
}

function compileSchema(schema: object | undefined): ReturnType<typeof compilePluginJsonSchema> | null {
  if (schema === undefined) return null;
  return compilePluginJsonSchema(schema);
}

function validates(validator: ReturnType<typeof compilePluginJsonSchema> | null, value: StrictJsonValue): boolean {
  if (!validator) return true;
  return isValidPluginJsonSchemaValue(validator, value);
}

type PluginActionAbortSource = 'caller' | 'generation';

function linkAbortSignals(generationSignal: AbortSignal, callerSignal?: AbortSignal): Readonly<{
  signal: AbortSignal;
  abortSource(): PluginActionAbortSource | null;
  dispose(): void;
}> {
  const controller = new AbortController();
  const sources: readonly Readonly<{ source: PluginActionAbortSource; signal: AbortSignal }>[] = [
    { source: 'generation', signal: generationSignal },
    ...(callerSignal ? [{ source: 'caller' as const, signal: callerSignal }] : []),
  ];
  let firstAbortSource: PluginActionAbortSource | null = null;
  const abort = (source: Readonly<{ source: PluginActionAbortSource; signal: AbortSignal }>) => {
    if (!controller.signal.aborted) {
      firstAbortSource = source.source;
      controller.abort(source.signal.reason);
    }
  };
  const listeners = sources.map((source) => {
    const listener = () => abort(source);
    if (source.signal.aborted) abort(source);
    else source.signal.addEventListener('abort', listener, { once: true });
    return { source, listener };
  });
  return Object.freeze({
    signal: controller.signal,
    abortSource() {
      return firstAbortSource;
    },
    dispose() {
      for (const { source, listener } of listeners) {
        source.signal.removeEventListener('abort', listener);
      }
    },
  });
}

type PluginActionHandlerSettlement =
  | Readonly<{ kind: 'fulfilled'; value: unknown }>
  | Readonly<{ kind: 'rejected'; error: unknown }>
  | Readonly<{ kind: 'aborted' }>;

const abortedPluginActionHandlerSettlement = Object.freeze({ kind: 'aborted' as const });

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof Reflect.get(value, 'then') === 'function';
}

function awaitPluginActionHandlerSettlementOrAbort(
  signal: AbortSignal,
  invoke: () => unknown | Promise<unknown>,
): Promise<PluginActionHandlerSettlement> {
  return new Promise<PluginActionHandlerSettlement>((resolve) => {
    let settled = false;
    let enteringHandler = false;
    let abortedDuringHandlerEntry = false;
    let resolveAbort: (() => void) | undefined;
    const abortSettlement = new Promise<typeof abortedPluginActionHandlerSettlement>((resolveAbortSettlement) => {
      resolveAbort = () => resolveAbortSettlement(abortedPluginActionHandlerSettlement);
    });
    function settle(settlement: PluginActionHandlerSettlement): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(settlement);
    }
    function onAbort(): void {
      if (enteringHandler) {
        abortedDuringHandlerEntry = true;
        return;
      }
      resolveAbort?.();
    }

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      settle(abortedPluginActionHandlerSettlement);
      return;
    }

    let value: unknown;
    try {
      enteringHandler = true;
      value = invoke();
    } catch (error) {
      settle(abortedDuringHandlerEntry
        ? abortedPluginActionHandlerSettlement
        : Object.freeze({ kind: 'rejected', error }));
      return;
    } finally {
      enteringHandler = false;
    }

    try {
      if (!isThenable(value)) {
        settle(abortedDuringHandlerEntry
          ? abortedPluginActionHandlerSettlement
          : Object.freeze({ kind: 'fulfilled', value }));
        return;
      }
      const handlerSettlement = Promise.resolve(value);
      if (abortedDuringHandlerEntry) {
        void handlerSettlement.then(
          () => undefined,
          () => undefined,
        );
        settle(abortedPluginActionHandlerSettlement);
        return;
      }
      // Both reactions are installed before invocation returns, so Promise
      // reaction order decides post-entry settlement without a timer.
      void Promise.race([handlerSettlement, abortSettlement]).then(
        (outcome) => settle(outcome === abortedPluginActionHandlerSettlement
          ? abortedPluginActionHandlerSettlement
          : Object.freeze({ kind: 'fulfilled', value: outcome })),
        (error) => settle(Object.freeze({ kind: 'rejected', error })),
      );
    } catch (error) {
      settle(abortedDuringHandlerEntry
        ? abortedPluginActionHandlerSettlement
        : Object.freeze({ kind: 'rejected', error }));
    }
  });
}

function readPluginError(error: unknown): Readonly<{ code: string; message: string }> | null {
  if (!(error instanceof Error) || error.name !== 'PluginError') return null;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  if (!code || !('value' in code) || typeof code.value !== 'string') return null;
  return Object.freeze({ code: code.value, message: error.message });
}

export function createPluginActionInvocation(params: Readonly<{
  pluginId: string;
  localId: string;
  inputSchema?: object;
  resultSchema?: object;
  generationSignal: AbortSignal;
  isCurrent(): boolean;
}>): Readonly<{
  qualifiedId: string;
  invoke(input: unknown, options: Readonly<{
    signal?: AbortSignal;
    /** Host-only admission that runs after input validation, before handler effects. */
    preDispatch?(input: PluginActionInvocationHandlerInput): (
      | PluginActionInvocationPreDispatchResult
      | null
      | Promise<PluginActionInvocationPreDispatchResult | null>
    );
    handler(input: PluginActionInvocationHandlerInput): unknown | Promise<unknown>;
  }>): Promise<PluginActionInvocationResult>;
}> {
  const qualifiedId = `${params.pluginId}/actions/${params.localId}`;
  const inputValidator = compileSchema(params.inputSchema);
  const resultValidator = compileSchema(params.resultSchema);

  return Object.freeze({
    qualifiedId,
    async invoke(input, options) {
      if (!params.isCurrent() || params.generationSignal.aborted) {
        return unavailable('plugin_action_generation_retired', 'Plugin action generation is no longer current');
      }
      if (options.signal?.aborted) {
        return unavailable('plugin_action_aborted', 'Plugin action invocation was aborted');
      }
      const parsedInput = AgentRuntimeJsonValueV1Schema.safeParse(input);
      if (!parsedInput.success || !validates(inputValidator, parsedInput.data)) return invalidInput;

      const linked = linkAbortSignals(params.generationSignal, options.signal);
      try {
        const handlerInput = Object.freeze({
          input: parsedInput.data,
          qualifiedId,
          signal: linked.signal,
        });
        const preDispatch = options.preDispatch;
        if (preDispatch) {
          const settlement = await awaitPluginActionHandlerSettlementOrAbort(
            linked.signal,
            () => preDispatch(handlerInput),
          );
          if (settlement.kind === 'aborted') {
            const abortSource = linked.abortSource();
            if (abortSource === 'caller') {
              return unavailable('plugin_action_aborted', 'Plugin action invocation was aborted');
            }
            if (abortSource === 'generation' || !params.isCurrent() || params.generationSignal.aborted) {
              return unavailable('plugin_action_generation_retired', 'Plugin action generation retired before dispatch');
            }
            return unavailable('plugin_action_aborted', 'Plugin action invocation was aborted');
          }
          if (settlement.kind === 'rejected') {
            if (!params.isCurrent() || params.generationSignal.aborted) {
              return unavailable('plugin_action_generation_retired', 'Plugin action generation retired before dispatch');
            }
            if (linked.signal.aborted) {
              return unavailable('plugin_action_aborted', 'Plugin action invocation was aborted');
            }
            return unavailable(
              'plugin_action_pre_dispatch_unavailable',
              'Plugin action invocation could not be admitted',
            );
          }
          if (!params.isCurrent() || params.generationSignal.aborted) {
            return unavailable('plugin_action_generation_retired', 'Plugin action generation retired before dispatch');
          }
          const result = readPreDispatchUnavailableResult(settlement.value);
          if (result) return result;
          if (settlement.value !== null) {
            return unavailable(
              'plugin_action_pre_dispatch_unavailable',
              'Plugin action invocation could not be admitted',
            );
          }
        }
        const settlement = await awaitPluginActionHandlerSettlementOrAbort(
          linked.signal,
          () => options.handler(handlerInput),
        );
        if (settlement.kind === 'aborted') {
          const abortSource = linked.abortSource();
          if (abortSource === 'caller') {
            return unavailable('plugin_action_aborted', 'Plugin action invocation was aborted');
          }
          if (abortSource === 'generation' || !params.isCurrent() || params.generationSignal.aborted) {
            return unavailable('plugin_action_generation_retired', 'Plugin action generation retired during execution');
          }
          return unavailable('plugin_action_aborted', 'Plugin action invocation was aborted');
        }
        if (settlement.kind === 'rejected') {
          const error = settlement.error;
          if (!params.isCurrent() || params.generationSignal.aborted) {
            return unavailable('plugin_action_generation_retired', 'Plugin action generation retired during execution');
          }
          const pluginError = readPluginError(error);
          if (pluginError) {
            return Object.freeze({
              status: 'failed',
              code: pluginError.code,
              message: pluginError.message,
            });
          }
          return Object.freeze({
            status: 'failed',
            code: 'plugin_action_execution_failed',
            message: error instanceof Error ? error.message : 'Plugin action execution failed',
          });
        }
        const value = settlement.value;
        if (!params.isCurrent() || params.generationSignal.aborted) {
          return unavailable(
            'plugin_action_generation_retired',
            'Plugin action generation retired before its result could be admitted',
          );
        }
        const rawResult = value === undefined ? null : value;
        const parsedResult = AgentRuntimeJsonValueV1Schema.safeParse(rawResult);
        if (!parsedResult.success) return invalidResult('Plugin action result must be JSON-safe');
        if (!validates(resultValidator, parsedResult.data)) {
          return invalidResult('Plugin action result does not match its manifest resultSchema');
        }
        return Object.freeze({ status: 'executed', value: parsedResult.data });
      } finally {
        linked.dispose();
      }
    },
  });
}
