import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { readAccountNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { createAccountArtifactStore } from './accountArtifactStore';
import { readCarrierMutation } from './accountArtifactStore.testkit';

afterEach(() => vi.restoreAllMocks());

it('retains recovery ordering in the private C1 item across restart and ignores older failure replays', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const rows = new Map<string, Record<string, unknown>>();
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...rows.values()]) };
    const row = rows.get(path.split('/')[3]!);
    return { status: row ? 200 : 404, data: row ?? {} };
  });
  const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
    const mutation = readCarrierMutation(value);
    const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
    const revision = Number(rows.get(id)?.bodyVersion ?? 0) + 1;
    rows.set(id, { ...rows.get(id), ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
      encryptionMode: 'plain', headerVersion: revision, bodyVersion: revision, seq: revision, createdAt: 1, updatedAt: revision });
    return { status: 200, data: { id, success: true, headerVersion: revision, bodyVersion: revision } };
  });
  const store = () => createAccountArtifactStore({ credentials: { token, encryption: null }, getAccountEncryptionMode: async () => 'plain' });
  const input = { accountId: 'owner', source: { kind: 'host' as const, topic: 'service_health' as const,
    subject: { kind: 'platformTarget' as const, environmentId: 'environment', targetLinkId: 'runtime' } },
    page: { kind: 'host' as const, page: 'environment' as const, targetLinkId: 'runtime',
      environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' } },
    title: 'Deployment recovered', type: 'update' as const, healthPhase: 'recovered' as const, resolved: false,
    platformTransition: { transitionId: 'recovery', observedAtMs: 200 } };
  const recovered = await store().writeNotice(input);
  expect(recovered).toMatchObject({ changed: true });
  expect(rows.size).toBe(1);
  const afterRecovery = writes.mock.calls.length;
  const replay = { ...input, title: 'Deployment failed', type: 'blocked' as const, healthPhase: 'open' as const,
    platformTransition: { transitionId: 'older-failure', observedAtMs: 100 } };
  expect(await store().writeNotice(replay)).toMatchObject({ artifactId: recovered.artifactId, changed: false });
  expect(await store().writeNotice({ ...replay, platformTransition: { transitionId: 'recovery', observedAtMs: 300 } }))
    .toMatchObject({ changed: false });
  expect(writes.mock.calls.length).toBe(afterRecovery);
  const retained = await store().read(recovered.artifactId, { includeSharedAudience: false });
  expect(retained && readAccountNoticeArtifactV1(retained)).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
  expect(await store().writeNotice({ ...replay, platformTransition: { transitionId: 'new-failure', observedAtMs: 300 } }))
    .toMatchObject({ artifactId: recovered.artifactId, changed: true });
  const beforeEqualTimeRecovery = writes.mock.calls.length;
  expect(await store().writeNotice({ ...replay, platformTransition: { transitionId: 'another-failure', observedAtMs: 300 } }))
    .toMatchObject({ artifactId: recovered.artifactId, changed: false });
  expect(writes.mock.calls.length).toBe(beforeEqualTimeRecovery);
  expect(await store().writeNotice({ ...input, platformTransition: { transitionId: 'equal-time-recovery', observedAtMs: 300 } }))
    .toMatchObject({ artifactId: recovered.artifactId, changed: true });
  const afterEqualTimeRecovery = writes.mock.calls.length;
  expect(await store().writeNotice({ ...replay, platformTransition: { transitionId: 'equal-time-late-failure', observedAtMs: 300 } }))
    .toMatchObject({ artifactId: recovered.artifactId, changed: false });
  expect(writes.mock.calls.length).toBe(afterEqualTimeRecovery);
  const retainedEqualTimeRecovery = await store().read(recovered.artifactId, { includeSharedAudience: false });
  expect(retainedEqualTimeRecovery && readAccountNoticeArtifactV1(retainedEqualTimeRecovery))
    .toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
  expect(rows.size).toBe(1);
});
