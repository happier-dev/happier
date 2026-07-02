import type {
  PiRpcCommandWithoutId,
  PiRpcResponse,
} from './types';

export type PendingRpcRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  commandType: PiRpcCommandWithoutId['type'];
};

export type PendingTurn = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  if (!resolve || !reject) {
    throw new Error('Failed to initialize deferred promise');
  }

  return { promise, resolve, reject };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

export class PiRpcCommandResponseTimeoutError extends Error {
  readonly commandType: PiRpcCommandWithoutId['type'];

  constructor(commandType: PiRpcCommandWithoutId['type']) {
    super(`Timed out waiting for Pi RPC response (${commandType})`);
    this.name = 'PiRpcCommandResponseTimeoutError';
    this.commandType = commandType;
  }
}

export function isPromptResponseTimeoutError(error: Error): boolean {
  if (error instanceof PiRpcCommandResponseTimeoutError) {
    return error.commandType === 'prompt';
  }
  return error.message.toLowerCase() === 'timed out waiting for pi rpc response (prompt)';
}

export function asFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export type PiThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh';

export function normalizePiThinkingEffort(raw: unknown): PiThinkingEffort | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  if (value === 'max') return 'xhigh';
  return null;
}

export type PiSessionModelState = {
  currentModelId: string;
  availableModels: Array<{
    id: string;
    name: string;
    description?: string;
    modelOptions?: unknown[];
  }>;
};
