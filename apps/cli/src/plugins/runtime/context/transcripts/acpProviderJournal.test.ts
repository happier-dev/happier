import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAcpProviderJournalFollower } from './acpProviderJournal';
import { createPluginTranscriptFileFollowService } from './fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from './fileFollowGrants';

it('follows only the resolved ACP journal and releases its exact grant with the source lifetime', async () => {
  await withTempDir('acp-journal-', async directory => {
    const path = join(directory, 'wire.jsonl');
    const foreign = join(directory, 'foreign.jsonl');
    await writeFile(path, '{"old":true}\n');
    await writeFile(foreign, '');
    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    const identity = { pluginId: 'fixture', runtimeId: 'runtime', scope: { kind: 'session' as const, sessionId: 'public' } };
    const lifetime = new AbortController();
    const lines: string[] = [];
    const follow = createAcpProviderJournalFollower({ ...identity, fileFollowPathGrants });
    const ordinary = createPluginTranscriptFileFollowService({ ...identity,
      readScope: () => identity.scope, fileFollowPathGrants });
    const handle = await follow({ providerSessionId: 'native', signal: lifetime.signal }, {
      path, startAt: 'end', onLine: ({ line }) => { lines.push(line); },
    });
    try {
      await appendFile(path, '{"new":true}\n');
      await handle.drainNow();
      expect(lines).toEqual(['{"new":true}']);
      expect(await fileFollowPathGrants.canFollowPath({ ...identity, path })).toBe(true);
      await expect(ordinary.follow({ path: foreign, startAt: 'end', onLine() {} }))
        .rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
      expect(await fileFollowPathGrants.canFollowPath({ ...identity, runtimeId: 'foreign', path })).toBe(false);
      lifetime.abort();
      await handle.close();
      expect(await fileFollowPathGrants.canFollowPath({ ...identity, path })).toBe(false);
      await expect(ordinary.follow({ path, startAt: 'end', onLine() {} }))
        .rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
      await appendFile(path, '{"stale":true}\n');
      await handle.drainNow();
      expect(lines).toEqual(['{"new":true}']);
    } finally { lifetime.abort(); await handle.close(); }
  });
});

it('does not retain a journal grant when the source has already stopped', async () => {
  await withTempDir('acp-journal-aborted-', async directory => {
    const path = join(directory, 'wire.jsonl');
    await writeFile(path, '');
    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    const identity = { pluginId: 'fixture', runtimeId: 'runtime', scope: { kind: 'execution_run' as const, executionRunId: 'run' } };
    const lifetime = new AbortController();
    lifetime.abort();
    await expect(createAcpProviderJournalFollower({ ...identity, fileFollowPathGrants })({
      providerSessionId: 'native', signal: lifetime.signal,
    }, { path, startAt: 'end', onLine() {} })).rejects.toThrow();
    expect(await fileFollowPathGrants.canFollowPath({ ...identity, path })).toBe(false);
  });
});
