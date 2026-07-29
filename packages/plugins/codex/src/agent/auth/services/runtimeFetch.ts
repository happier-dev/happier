export type CodexRuntimeFetchRequest = Readonly<{
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type CodexRuntimeFetchResponse = Readonly<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type CodexRuntimeFetch = (
  request: CodexRuntimeFetchRequest,
) => Promise<CodexRuntimeFetchResponse>;
