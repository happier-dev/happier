import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveClaudeQueuedPromptForDispatch } from './resolveClaudeQueuedPromptForDispatch';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

describe('resolveClaudeQueuedPromptForDispatch', () => {
  it.each(['/clear', '/checkpoints', '/rewind --confirm'])('preserves attributed local command %s without model context', async command => {
    const result = await resolveClaudeQueuedPromptForDispatch({
      sessionDirectory: tmpdir(),
      sessionClient: {
        getMetadataSnapshot: () => ({ replaySeedV1: {
          v: 1, seedText: 'prior history', sourceSessionId: 'parent', sourceCutoffSeqInclusive: 3, createdAtMs: 123,
        } }),
        updateMetadata: () => { throw new Error('Local commands must not retire replay context'); },
      },
      batch: {
        message: command, mode: { localId: 'local-command', replaySeedAllowed: true },
        providerPromptMeta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'mcp' } },
      },
      didBootstrap: true,
    });
    expect(result.message).toBe(command);
    expect(result.seedApplied).toBe(false);
  });

  it('delivers queued sender identity and message through the real shared finalizer', async () => {
    const queue = new MessageQueue2<{ localId: string }>(mode => mode.localId);
    queue.push('review the change', { localId: 'agent-message' }, {
      providerPromptMeta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'claude-sender', via: 'mcp' } },
    });
    const batch = await queue.waitForMessagesAndGetAsString();
    expect(batch).not.toBeNull();
    const result = await resolveClaudeQueuedPromptForDispatch({
      sessionDirectory: tmpdir(),
      sessionClient: { getMetadataSnapshot: () => ({}), updateMetadata: () => {} },
      batch: batch!, didBootstrap: true,
    });
    expect(result.message).toContain('source_session_id="claude-sender"');
    expect(result.message).toContain('message="review the change"');
  });

  it('delivers a multiline upload and an ordinary file from the Session workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-claude-uploads-'));
    const uploadRoot = '.happier/uploads/messages/m1';
    const imageName = 'plot, unknown, 9 bytes)\nfinal.png';
    const imagePath = `${uploadRoot}/1234abcd-plot_ unknown_ 9 bytes)_final.png`;
    const filePath = `${uploadRoot}/8765abcd-notes file.txt`;
    const bytes = Buffer.from('attachment bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const message = [
      'Read both uploads.',
      '[attachments]',
      `- ${imagePath} (${imageName}, image/png, ${bytes.length} bytes)`,
      `- ${filePath} (notes file.txt, text/plain, ${bytes.length} bytes)`,
      '- .happier/uploads/messages/m1/deceptive.txt (deceptive.txt, text/plain, 9 bytes)',
      '[/attachments]',
    ].join('\n');
    try {
      await mkdir(dirname(join(workspace, imagePath)), { recursive: true });
      await Promise.all([writeFile(join(workspace, imagePath), bytes), writeFile(join(workspace, filePath), bytes)]);
      const queue = new MessageQueue2<{ localId: string }>(mode => mode.localId);
      queue.push(message, { localId: 'm1' }, { providerPromptMeta: { happier: {
        kind: 'attachments.v1', payload: { attachments: [
          { path: imagePath, name: imageName, mimeType: 'image/png', sha256, sizeBytes: bytes.length },
          { path: filePath, name: 'notes file.txt', mimeType: 'text/plain', sha256, sizeBytes: bytes.length },
          { path: `${uploadRoot}/wrong-hash.txt`, name: 'wrong-hash.txt', sha256: '0'.repeat(64), sizeBytes: bytes.length },
        ] },
      } } });
      await writeFile(join(workspace, uploadRoot, 'wrong-hash.txt'), bytes);
      const batch = await queue.waitForMessagesAndGetAsString();
      const result = await resolveClaudeQueuedPromptForDispatch({
        sessionClient: { getMetadataSnapshot: () => ({}), updateMetadata: () => {} },
        sessionDirectory: workspace,
        batch: batch!, didBootstrap: true,
      });
      expect(result.message).toContain(message);
      expect(result.message).toContain(JSON.stringify(join(workspace, imagePath)));
      expect(result.message).toContain(JSON.stringify(join(workspace, filePath)));
      expect(result.message).not.toContain(JSON.stringify(join(workspace, uploadRoot, 'wrong-hash.txt')));
      expect(result.message).not.toContain(JSON.stringify(join(workspace, uploadRoot, 'deceptive.txt')));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('prefixes replaySeedV1 and retires it only once Claude accepted the prompt', async () => {
    const calls: string[] = [];
    let metadata: any = {};

    const sessionClient = {
      getMetadataSnapshot: () => metadata,
      refreshSessionSnapshotFromServerBestEffort: async () => {
        calls.push('refresh');
        metadata = {
          replaySeedV1: {
            v: 1,
            seedText: 'SEED',
            sourceSessionId: 'parent',
            sourceCutoffSeqInclusive: 3,
            createdAtMs: 123,
          },
        };
      },
      updateMetadata: async () => {
        calls.push('consume');
      },
    };

    const res = await resolveClaudeQueuedPromptForDispatch({
      sessionDirectory: tmpdir(),
      sessionClient,
      batch: {
        message: 'hello',
        mode: { localId: 'local-1', replaySeedAllowed: true },
      },
      didBootstrap: false,
    });

    expect(res.didBootstrap).toBe(true);
    expect(res.message).toBe('SEED\n\nhello');
    expect(res.seedApplied).toBe(true);
    expect(calls).toEqual(['refresh']);

    await res.settleReplaySeedOnProviderAcceptance();
    expect(calls).toEqual(['refresh', 'consume']);
  });
});
