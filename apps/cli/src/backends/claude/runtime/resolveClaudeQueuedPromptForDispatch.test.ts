import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { resolveSessionMediaTempUploadBasePath } from '@/transfers/sessionMedia/resolveSessionMediaTransferTarget';

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
      expect(result.message).toContain(JSON.stringify(await realpath(join(workspace, imagePath))));
      expect(result.message).toContain(JSON.stringify(await realpath(join(workspace, filePath))));
      expect(result.message).not.toContain(JSON.stringify(join(workspace, uploadRoot, 'wrong-hash.txt')));
      expect(result.message).not.toContain(JSON.stringify(join(workspace, uploadRoot, 'deceptive.txt')));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fits the replay seed after accounting for upload paths carried with review comments', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-claude-review-upload-'));
    const relativePath = '.happier/uploads/messages/m1/notes.txt';
    const absolutePath = join(workspace, relativePath);
    const bytes = 'attachment bytes';
    vi.stubEnv('HAPPIER_REPLAY_MAX_SEED_CHARS', '500');
    reloadConfiguration();
    try {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, bytes);
      const happierAttachments = { kind: 'attachments.v1', payload: { attachments: [{
        path: relativePath, name: 'notes.txt', mimeType: 'text/plain', sizeBytes: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }] } };
      const sessionClient = {
        getMetadataSnapshot: () => ({ replaySeedV1: {
          v: 1, seedText: 'S'.repeat(configuration.replaySeedMaxChars), sourceSessionId: 'parent',
          sourceCutoffSeqInclusive: 3, createdAtMs: 123,
        } }),
        updateMetadata: () => { throw new Error('Undelivered replay seed must remain available'); },
      };
      const dispatch = (providerPromptMeta: unknown) => resolveClaudeQueuedPromptForDispatch({
        sessionClient, sessionDirectory: workspace, didBootstrap: true,
        batch: { message: 'Apply the review.', mode: { localId: 'review', replaySeedAllowed: true }, providerPromptMeta },
      });
      const attachmentOnly = await dispatch({ happier: happierAttachments });
      expect.soft(attachmentOnly.message).toContain(JSON.stringify(await realpath(absolutePath)));
      expect.soft(attachmentOnly.seedApplied).toBe(false);
      const combined = await dispatch({ happier: { kind: 'review_comments.v1', payload: {} }, happierAttachments });
      expect.soft(combined.message).toContain(JSON.stringify(await realpath(absolutePath)));
      expect.soft(combined.seedApplied).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      reloadConfiguration();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps upload reads within the workspace upload directory or the transfer temp root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-upload-scope-'));
    const temporaryRoot = join(resolveSessionMediaTempUploadBasePath(), randomUUID());
    try {
      const workspace = join(root, 'workspace');
      const relativeDir = '.happier/uploads/messages/m1';
      const unrelatedDir = join(root, 'shadow/happier/uploads/other/messages/m1');
      const unrelatedPath = join(unrelatedDir, 'unrelated.txt');
      const bytes = 'attachment bytes';
      await mkdir(unrelatedDir, { recursive: true });
      await mkdir(dirname(join(workspace, relativeDir)), { recursive: true });
      await writeFile(unrelatedPath, bytes);
      await symlink(unrelatedDir, join(workspace, relativeDir), 'junction');
      const customWorkspacePath = 'incoming/messages/m1/1234abcd-upload.txt';
      const temporaryPath = join(temporaryRoot, 'messages', 'm1', 'upload.txt');
      await mkdir(dirname(join(workspace, customWorkspacePath)), { recursive: true });
      await mkdir(dirname(temporaryPath), { recursive: true });
      await writeFile(join(workspace, customWorkspacePath), bytes);
      await writeFile(temporaryPath, bytes);
      const result = await resolveClaudeQueuedPromptForDispatch({
        sessionDirectory: workspace,
        sessionClient: { getMetadataSnapshot: () => ({}), updateMetadata: () => {} },
        didBootstrap: true,
        batch: { message: 'Read the uploads.', mode: { localId: 'm1' }, providerPromptMeta: { happier: {
          kind: 'attachments.v1', payload: { attachments: [unrelatedPath, `${relativeDir}/unrelated.txt`, customWorkspacePath, temporaryPath].map(path => ({
            path, name: path.includes('unrelated') ? 'unrelated.txt' : 'upload.txt', mimeType: 'text/plain', sizeBytes: Buffer.byteLength(bytes),
            sha256: createHash('sha256').update(bytes).digest('hex'),
          })) },
        } } },
      });
      expect(result.message).not.toContain('unrelated.txt');
      expect(result.message).toContain(JSON.stringify(await realpath(temporaryPath)));
      expect(result.message).toContain(JSON.stringify(await realpath(join(workspace, customWorkspacePath))));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
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
