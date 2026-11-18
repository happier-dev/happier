import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { readAccountNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createCliInboxReadAction } from '@/session/actions/inboxActions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAccountArtifactStore } from './accountArtifactStore';
import { createPlainAccountArtifactHttpBoundary } from './accountArtifactStore.testkit';

afterEach(() => vi.restoreAllMocks());

it('reopens the same private notice after dismissal, resolution and a new request', async () => {
  const boundary = createPlainAccountArtifactHttpBoundary();
  const createStore = () => createAccountArtifactStore({ credentials: boundary.credentials,
    getAccountEncryptionMode: async () => 'plain' });
  const store = createStore();
  const input = { accountId: 'owner', source: { kind: 'plugin' as const,
    pluginId: 'happier.triage', itemId: 'stable-review-needs-you' },
    type: 'decision' as const, title: 'Review needs you', resolved: false };
  const first = await store.writeNotice(input);
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    appShellAction: createCliInboxReadAction({ store, accountId: 'owner', serverId: 'home' }) });
  expect(await executor.execute('inbox.notice.dismiss', { artifactId: first.artifactId },
    { surface: 'cli', authority: 'account_automation', serverId: 'home',
      runtimeAccountId: 'owner', expectedAccountId: 'owner' }))
    .toMatchObject({ ok: true, result: { artifactId: first.artifactId, status: 'dismissed' } });
  // A repeated hint for the same unresolved request preserves the person's dismissal.
  expect(await store.writeNotice(input)).toMatchObject({ artifactId: first.artifactId, opened: false });
  expect(await store.read(first.artifactId, { includeSharedAudience: false }))
    .toMatchObject({ header: { status: 'dismissed', resolved: false } });
  await store.writeNotice({ ...input, resolved: true });
  // The retained notice, rather than process-local memory, owns recurrence.
  const restarted = createStore();
  expect(await restarted.writeNotice(input))
    .toMatchObject({ artifactId: first.artifactId, changed: true, opened: true, pushWorthy: true });
  const renewed = await restarted.read(first.artifactId, { includeSharedAudience: false });
  expect(renewed && readAccountNoticeArtifactV1(renewed))
    .toMatchObject({ status: 'open', resolved: false, source: input.source });
  expect(boundary.rows.size).toBe(1);
});
