import { describe, expect, it } from 'vitest';

import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createDeferred, createFakeAcpRuntimeBackend, createSessionClientWithMetadata } from '../createAcpRuntime.testkit';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createAcpRuntime (history import)', () => {
  it('does not prompt to import divergent replay history when import is disabled', async () => {
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
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote', importHistory: false });

    const didPrompt = await Promise.race([
      prompted.promise.then(() => true),
      delay(30).then(() => false),
    ]);

    expect(didPrompt).toBe(false);
  });
});
