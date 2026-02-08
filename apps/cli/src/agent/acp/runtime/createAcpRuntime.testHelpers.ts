import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { Metadata } from '@/api/types';
import type { ACPMessageData } from '@/api/apiSession';

import type { AcpRuntimeBackend } from './createAcpRuntime';

export type FakeAcpRuntimeBackend = AcpRuntimeBackend & {
  emit: (msg: AgentMessage) => void;
};

export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createFakeAcpRuntimeBackend(opts?: { sessionId?: string }): FakeAcpRuntimeBackend {
  let handler: ((msg: AgentMessage) => void) | null = null;
  const sessionId = opts?.sessionId ?? 'sess_main';
  return {
    onMessage(fn: (msg: AgentMessage) => void) {
      handler = fn;
    },
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: string, _prompt: string) {
      // noop
    },
    async waitForResponseComplete() {
      // noop
    },
    async cancel() {
      // noop
    },
    async dispose() {
      // noop
    },
    emit(msg: AgentMessage) {
      handler?.(msg);
    },
  };
}

export function createDefaultMetadata(overrides?: Partial<Metadata>): Metadata {
  return {
    path: '/tmp',
    host: 'host',
    homeDir: '/home',
    happyHomeDir: '/happy',
    happyLibDir: '/lib',
    happyToolsDir: '/tools',
    ...(overrides ?? {}),
  };
}

export function createSessionClientWithMetadata(opts?: {
  initialMetadata?: Metadata;
  onSendAgentMessageCommitted?: (body: ACPMessageData) => void;
}): {
  session: AcpRuntimeSessionClient;
  metadataUpdates: Metadata[];
  committed: ACPMessageData[];
  getMetadata: () => Metadata;
} {
  let metadata = opts?.initialMetadata ?? createDefaultMetadata();
  const metadataUpdates: Metadata[] = [];
  const committed: ACPMessageData[] = [];
  const session: AcpRuntimeSessionClient = {
    keepAlive: () => {},
    sendAgentMessage: () => {},
    sendAgentMessageCommitted: async (_provider, body, _opts) => {
      committed.push(body);
      opts?.onSendAgentMessageCommitted?.(body);
    },
    sendUserTextMessageCommitted: async (_text, _opts) => {},
    fetchRecentTranscriptTextItemsForAcpImport: async () => [],
    updateMetadata: (handler) => {
      metadata = handler(metadata);
      metadataUpdates.push(metadata);
    },
  };
  return { session, metadataUpdates, committed, getMetadata: () => metadata };
}

export function createBasicSessionClient(): AcpRuntimeSessionClient {
  return {
    keepAlive: () => {},
    sendAgentMessage: () => {},
    sendAgentMessageCommitted: async (_provider, _body, _opts) => {},
    sendUserTextMessageCommitted: async (_text, _opts) => {},
    fetchRecentTranscriptTextItemsForAcpImport: async () => [],
    updateMetadata: (_handler) => {},
  };
}

export function createApprovedPermissionHandler(): AcpPermissionHandler {
  return {
    handleToolCall: async () => ({ decision: 'approved' }),
  };
}
