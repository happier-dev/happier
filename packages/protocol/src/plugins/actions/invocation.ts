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
    cause?: unknown;
  }
>;

export type PluginActionInvocationHandlerInput = Readonly<{
  input: StrictJsonValue;
  qualifiedId: string;
  signal: AbortSignal;
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

function compileSchema(schema: object | undefined): ReturnType<typeof compilePluginJsonSchema> | null {
  if (schema === undefined) return null;
  return compilePluginJsonSchema(schema);
}

function validates(validator: ReturnType<typeof compilePluginJsonSchema> | null, value: StrictJsonValue): boolean {
  if (!validator) return true;
  return isValidPluginJsonSchemaValue(validator, value);
}

function linkAbortSignals(generationSignal: AbortSignal, callerSignal?: AbortSignal): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const sources = callerSignal ? [generationSignal, callerSignal] : [generationSignal];
  const abort = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const listeners = sources.map((source) => {
    const listener = () => abort(source);
    if (source.aborted) abort(source);
    else source.addEventListener('abort', listener, { once: true });
    return { source, listener };
  });
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      for (const { source, listener } of listeners) {
        source.removeEventListener('abort', listener);
      }
    },
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
        const value = await options.handler(Object.freeze({
          input: parsedInput.data,
          qualifiedId,
          signal: linked.signal,
        }));
        if (!params.isCurrent() || params.generationSignal.aborted) {
          return unavailable(
            'plugin_action_generation_retired',
            'Plugin action generation retired before its result could be admitted',
          );
        }
        // A handler's successful settlement is authoritative even if caller cancellation
        // raced it: the handler may already have committed an outward effect.
        const rawResult = value === undefined ? null : value;
        const parsedResult = AgentRuntimeJsonValueV1Schema.safeParse(rawResult);
        if (!parsedResult.success) return invalidResult('Plugin action result must be JSON-safe');
        if (!validates(resultValidator, parsedResult.data)) {
          return invalidResult('Plugin action result does not match its manifest resultSchema');
        }
        return Object.freeze({ status: 'executed', value: parsedResult.data });
      } catch (error) {
        if (!params.isCurrent() || params.generationSignal.aborted) {
          return unavailable('plugin_action_generation_retired', 'Plugin action generation retired during execution');
        }
        if (linked.signal.aborted) {
          return unavailable('plugin_action_aborted', 'Plugin action invocation was aborted');
        }
        const pluginError = readPluginError(error);
        if (pluginError) {
          return Object.freeze({
            status: 'failed',
            code: pluginError.code,
            message: pluginError.message,
            cause: error,
          });
        }
        return Object.freeze({
          status: 'failed',
          code: 'plugin_action_execution_failed',
          message: error instanceof Error ? error.message : 'Plugin action execution failed',
          cause: error,
        });
      } finally {
        linked.dispose();
      }
    },
  });
}
