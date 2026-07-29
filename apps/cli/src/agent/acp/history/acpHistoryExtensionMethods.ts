import { RequestError } from '@agentclientprotocol/sdk';

import type { JsonValue } from '@happier-dev/plugin-sdk';

export const ACP_HISTORY_EXTENSION_METHOD_LIMIT = 8;

const EXTENSION_METHOD_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const EXTENSION_METHOD_MAX_CODE_UNITS = 256;

export function isNamespacedAcpExtensionMethod(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= EXTENSION_METHOD_MAX_CODE_UNITS
    && EXTENSION_METHOD_PATTERN.test(value);
}

function assertHistoryExtensionMethods(methods: readonly string[]): void {
  if (
    !Array.isArray(methods)
    || methods.length === 0
    || methods.length > ACP_HISTORY_EXTENSION_METHOD_LIMIT
  ) {
    throw new Error(
      `ACP history extension methods must contain between 1 and ${ACP_HISTORY_EXTENSION_METHOD_LIMIT} entries`,
    );
  }
  for (const method of methods) {
    if (!isNamespacedAcpExtensionMethod(method)) {
      throw new Error(`ACP history extension methods contain an invalid method '${method}'`);
    }
  }
}

export async function requestAcpHistoryExtension(input: Readonly<{
  methods: readonly string[];
  params: JsonValue;
  options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>;
  assertCurrent?: () => void;
  requestExtension(
    method: string,
    params: JsonValue,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<JsonValue>;
}>): Promise<JsonValue> {
  assertHistoryExtensionMethods(input.methods);
  for (let index = 0; index < input.methods.length; index += 1) {
    input.options?.signal?.throwIfAborted();
    input.assertCurrent?.();
    const method = input.methods[index]!;
    try {
      return await input.requestExtension(method, input.params, input.options);
    } catch (error) {
      const canTryNextMethod = index + 1 < input.methods.length
        && error instanceof RequestError
        && error.code === -32601;
      if (!canTryNextMethod) throw error;
    }
  }
  throw new Error('ACP history extension methods were unexpectedly exhausted');
}
