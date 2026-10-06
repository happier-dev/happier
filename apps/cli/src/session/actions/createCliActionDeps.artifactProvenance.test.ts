import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2UpdateRequestSchema, decodePlainArtifactStoredContent, type ActionExecutorContext } from '@happier-dev/protocol';
import { createCliActionDeps } from './createCliActionDeps';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: http }));

describe('CLI admitted Artifact attribution', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    http.get.mockReset();
    http.post.mockReset();
    http.get.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    http.post.mockImplementation(async (_url: string, input: Record<string, unknown>) => ({ status: 200,
      data: { id: input.id, headerVersion: 1, bodyVersion: 1 } }));
  });

  it('keeps an admitted Launch publisher session outside public content through the real CLI dependency owner', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'launch-account' })).toString('base64url')}.signature`;
    let settings: { content: { t: 'plain'; v: Record<string, unknown> }; version: number } = { content: { t: 'plain', v: { profiles: [{ v: 2, id: 'work', name: 'Work',
      createdAt: 1, updatedAt: 1, extraEnvironmentVariables: [] }], secretBindingsByProfileId: {} } }, version: 1 };
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/v2/account/settings') ? settings : { mode: 'plain', updatedAt: 1 } }));
    http.post.mockImplementation(async (url: string, input: Record<string, unknown>) => {
      if (url.endsWith('/v2/account/settings')) {
        const content = AccountSettingsV2UpdateRequestSchema.parse(input).content;
        if (content?.t !== 'plain') throw new Error('Plain Account settings boundary requires plain content');
        settings = { content, version: settings.version + 1 };
        return { status: 200, data: { success: true, version: settings.version } };
      }
      return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'bound-session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    await expect(deps.launchProfilePublish!({ profileId: 'work' }, { context: { surface: 'cli', authority: 'present_user',
      runtimeAccountId: 'untrusted-account', defaultSessionId: 'target-session',
      actionCaller: { kind: 'session', sessionId: 'admitted-launch-session', starterDepth: 0, turnDepth: 0 } } }))
      .resolves.toMatchObject({ artifactId: expect.any(String) });
    const artifactWrite = http.post.mock.calls.find(([url]) => url.endsWith('/v1/artifacts'))?.[1];
    expect(artifactWrite).toBeDefined();
    expect(decodePlainArtifactStoredContent(artifactWrite.provenance)).toMatchObject({ artifactId: artifactWrite.id,
      bodyVersion: 1, provenance: { savedBy: { kind: 'agent', accountId: 'launch-account', sessionId: 'admitted-launch-session' } } });
    expect(decodePlainArtifactStoredContent(artifactWrite.header)).not.toHaveProperty('savedBy');
    const opened = decodePlainArtifactStoredContent(artifactWrite.body);
    expect(opened).not.toHaveProperty('provenance');
    expect(settings.content.v.profiles).toEqual([{ artifactId: artifactWrite.id }]);
  });

  it('uses the captured Account and each admitted caller rather than a target or caller-authored body', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'captured-account' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'bound-session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    const contexts: ActionExecutorContext[] = [
      { surface: 'cli', authority: 'present_user', runtimeAccountId: 'caller-body-account', defaultSessionId: 'target-session' },
      { surface: 'agent', runtimeAccountId: 'caller-body-account', actionCaller: { kind: 'session', sessionId: 'admitted-session', starterDepth: 0, turnDepth: 0 } },
      { surface: 'agent' },
    ];
    for (const context of contexts) {
      await expect(deps.artifactAction!({ actionId: 'artifact.create', input: { header: { title: 'Result' }, body: 'No actor here' }, context }))
        .resolves.toMatchObject({ revision: { bodyVersion: 1 } });
    }
    const expected = [
      { kind: 'person', accountId: 'captured-account' },
      { kind: 'agent', accountId: 'captured-account', sessionId: 'admitted-session' },
      { kind: 'agent', accountId: 'captured-account', sessionId: 'bound-session' },
    ];
    for (const [index, call] of http.post.mock.calls.entries()) {
      expect(decodePlainArtifactStoredContent(call[1].body)).toEqual({ body: 'No actor here' });
      expect(decodePlainArtifactStoredContent(call[1].provenance)).toEqual({ v: 1, artifactId: call[1].id, bodyVersion: 1,
        provenance: { savedBy: expected[index] } });
    }
  });
});
