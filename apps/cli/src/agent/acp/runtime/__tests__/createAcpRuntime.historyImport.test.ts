import { describe, expect, it } from 'vitest';

import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createDeferred } from '@/testkit/async/deferred';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createApprovedPermissionHandler(): AcpPermissionHandler {
  return {
    handleToolCall: async () => ({ decision: 'approved' }),
  };
}

describe('createAcpRuntime (history import)', () => {
  it('does not prompt to import divergent replay history by default', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_remote',
      replay: [
        { type: 'message', role: 'user', text: 'REMOTE: hello' },
        { type: 'message', role: 'agent', text: 'REMOTE: hi' },
      ],
    });

    const prompted = createDeferred<void>();
    const permissionHandler = {
      handleToolCall: async () => {
        prompted.resolve(undefined);
        return { decision: 'denied' as const };
      },
    };

    const base = createSessionClientWithMetadata();
    const session = {
      ...base.session,
      fetchRecentTranscriptTextItemsForAcpImport: async () => [
        { role: 'user' as const, text: 'LOCAL: one' },
        { role: 'agent' as const, text: 'LOCAL: two' },
        { role: 'user' as const, text: 'LOCAL: three' },
      ],
    };

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionOpenIntent: {
        kind: 'resume',
        providerSessionId: 'ses_remote',
        importHistory: false,
      },
    });

    await runtime.sendTurnPrompt('Current prompt');

    const didPrompt = await Promise.race([
      prompted.promise.then(() => true),
      delay(30).then(() => false),
    ]);

    expect(didPrompt).toBe(false);
  });

  it('prompts to import divergent replay history when import is explicitly enabled', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_remote',
      replay: [
        { type: 'message', role: 'user', text: 'REMOTE: hello' },
        { type: 'message', role: 'agent', text: 'REMOTE: hi' },
      ],
    });

    const prompted = createDeferred<void>();
    const permissionHandler = {
      handleToolCall: async () => {
        prompted.resolve(undefined);
        return { decision: 'denied' as const };
      },
    };

    const base = createSessionClientWithMetadata();
    const session = {
      ...base.session,
      fetchRecentTranscriptTextItemsForAcpImport: async () => [
        { role: 'user' as const, text: 'LOCAL: one' },
        { role: 'agent' as const, text: 'LOCAL: two' },
        { role: 'user' as const, text: 'LOCAL: three' },
      ],
    };

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionOpenIntent: {
        kind: 'resume',
        providerSessionId: 'ses_remote',
        importHistory: true,
      },
    });

    await runtime.sendTurnPrompt('Current prompt');

    const didPrompt = await Promise.race([
      prompted.promise.then(() => true),
      delay(30).then(() => false),
    ]);

    expect(didPrompt).toBe(true);
  });

  it('waits for enabled replay import before resolving a loaded session', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_remote',
      replay: [
        { type: 'message', role: 'user', text: 'LOCAL: one' },
        { type: 'message', role: 'agent', text: 'LOCAL: two' },
        { type: 'message', role: 'agent', text: 'REMOTE: new' },
      ],
    });

    const importStarted = createDeferred<void>();
    const allowExistingRead = createDeferred<{ role: 'user' | 'agent'; text: string }[]>();
    const base = createSessionClientWithMetadata();
    const session = {
      ...base.session,
      fetchRecentTranscriptTextItemsForAcpImport: async () => {
        importStarted.resolve(undefined);
        return await allowExistingRead.promise;
      },
    };

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionOpenIntent: {
        kind: 'resume',
        providerSessionId: 'ses_remote',
        importHistory: true,
      },
    });

    let settled = false;
    const start = runtime.sendTurnPrompt('Current prompt').then(() => {
      settled = true;
    });
    await importStarted.promise;
    await delay(0);
    expect(settled).toBe(false);

    allowExistingRead.resolve([
      { role: 'user', text: 'LOCAL: one' },
      { role: 'agent', text: 'LOCAL: two' },
    ]);

    await expect(start).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('excludes the current materialized prompt from replay import overlap checks', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_remote',
      replay: [
        { type: 'message', role: 'user', text: 'LOCAL: one' },
        { type: 'message', role: 'agent', text: 'LOCAL: two' },
        { type: 'message', role: 'user', text: 'Current prompt' },
      ],
    });

    const sentUserMessages: string[] = [];
    const base = createSessionClientWithMetadata();
    const session = {
      ...base.session,
      fetchRecentTranscriptTextItemsForAcpImport: async () => [
        { role: 'user' as const, text: 'LOCAL: one' },
        { role: 'agent' as const, text: 'LOCAL: two' },
      ],
      sendUserTextMessageCommitted: async (text: string) => {
        sentUserMessages.push(text);
      },
    };

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionOpenIntent: {
        kind: 'resume',
        providerSessionId: 'ses_remote',
        importHistory: true,
      },
    });

    await runtime.sendTurnPrompt('Current prompt');

    expect(sentUserMessages).toEqual([]);
  });
});
