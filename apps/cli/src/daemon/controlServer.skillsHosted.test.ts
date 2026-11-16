import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { mintSessionTrackingKey } from './sessions/sessionTrackingKey';
import type { TrackedSession } from './types';
import { createDaemonControlApp } from './controlServer';
import { ensureSkillSessionDirHttp } from './controlClient';
import { configuration } from '@/configuration';

it('delivers built-in and selected skills to the addressed Session in a shared host and retains refusal causes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skills-hosted-'));
  const store = createSkillStore({ happyHomeDir: home });
  const sessions: TrackedSession[] = ['earlier-session', 'target-session'].map(happySessionId => ({
    trackingKey: mintSessionTrackingKey(), pid: process.pid, sessionRunnerPid: process.pid,
    startedBy: 'daemon', happySessionId,
  }));
  const app = createDaemonControlApp({ getChildren: () => sessions,
    trackedSessionsByKey: new Map(sessions.map(item => [item.trackingKey, item])), machineId: 'machine',
    stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
    requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token', skillStore: store });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const target = { pid: process.pid, httpPort: Number(new URL(url).port), controlToken: 'test-token' };
  const files = [{ path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: Buffer.from('Delivered instructions').toString('base64') }];
  const request = { ownerKey: 'target-session', items: ['happier:happier', 'selected-skill'].map(skillId => ({
    skillId, name: skillId === 'happier:happier' ? 'happier' : skillId, files,
    digest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }),
  })), nativeDisables: [] };
  const metadata = createTestMetadata({ hostPid: process.pid, path: home, startedBy: 'daemon', happyHomeDir: configuration.happyHomeDir });
  try {
    const delivery = await ensureSkillSessionDirHttp(request, { target }, { pid: process.pid, metadata });
    expect(delivery.failed).toEqual([]);
    expect(delivery.items.map(item => item.skillId)).toEqual(['happier:happier', 'selected-skill']);
    expect(await readFile(join(delivery.skillsRoot, 'happier', 'SKILL.md'), 'utf8')).toBe('Delivered instructions');
    expect(sessions.map(item => item.happySessionId)).toEqual(['earlier-session', 'target-session']);
    await expect(ensureSkillSessionDirHttp(request, { target }, { pid: process.pid,
      metadata: { ...metadata, hostPid: process.pid + 1 } })).rejects.toMatchObject({ code: 'skill_session_identity_mismatch' });
  } finally {
    await app.close();
    await store.releaseSkillSessionDirs(request.ownerKey);
    await store.collectSkillCache({ libraryDigests: [] });
    await rm(home, { recursive: true, force: true });
  }
});
