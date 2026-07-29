import {
  cursorListAvailableModelsResponseSchema,
  type CursorAvailableModel,
} from './schemas.js';

export const CURSOR_LIST_AVAILABLE_MODELS_METHOD = 'cursor/list_available_models';

type CursorJsonRpcRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type AcpExtensionRequester = (
  method: string,
  params?: unknown,
  options?: CursorJsonRpcRequestOptions,
) => Promise<unknown>;

export async function listCursorAvailableModels(params: Readonly<{
  request: AcpExtensionRequester;
  timeoutMs: number;
  signal?: AbortSignal;
}>): Promise<readonly CursorAvailableModel[]> {
  const response = await params.request(CURSOR_LIST_AVAILABLE_MODELS_METHOD, {}, {
    ...(params.signal ? { signal: params.signal } : {}),
    timeoutMs: params.timeoutMs,
  });
  return cursorListAvailableModelsResponseSchema.parse(response).models;
}
