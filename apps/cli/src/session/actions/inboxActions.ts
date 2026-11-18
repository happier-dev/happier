import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { AppShellActionOutputSchemas, projectInboxReadItemV1, readNoticeInboxAccountIdV1,
  mutateAccountNoticeArtifactV1 } from '@happier-dev/protocol/actions/appShellActionFamily';
import { isAccountNoticeMutationActionIdV1 } from '@happier-dev/protocol/actions/appShellActionIdsV1';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1, inboxNoticeFocusKeyV1, normalizeAccountNoticeArtifactV1,
  projectAccountNoticeInboxItemV1, projectOpenUsageNoticeHeaderV1, readOwnedNoticeArtifactAdmissionV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

const NOTICE_ARTIFACT_KINDS = [ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1] as const;

/** Finite headless source adapter over the incumbent private Artifact reader, never an Inbox store. */
export function createCliInboxReadAction(params: Readonly<{
  store: Pick<ReturnType<typeof createAccountArtifactStore>, 'list' | 'readBodies' | 'read' | 'update'>;
  accountId: string; serverId: string; isCurrent?: () => boolean | Promise<boolean>;
}>): NonNullable<ActionExecutorDeps['appShellAction']> {
  return async ({ actionId, input, context }) => {
    if (isAccountNoticeMutationActionIdV1(actionId)) {
      const accountId = readNoticeInboxAccountIdV1(context);
      if (accountId !== params.accountId) return { ok: false, errorCode: 'forbidden', error: 'forbidden' };
      const assertCurrent = async () => {
        context.signal?.throwIfAborted();
        if ((context.serverId && context.serverId !== params.serverId && !await isServerProfileHomeIdentity(params.serverId, context.serverId))
          || params.isCurrent && !await params.isCurrent()) throw Object.assign(new Error('credential_scope_retired'), { code: 'credential_scope_retired' });
      };
      return mutateAccountNoticeArtifactV1(actionId, input, { accountId, assertCurrent,
        read: artifactId => params.store.read(artifactId, { signal: context.signal, includeSharedAudience: false, ownerOnly: true }),
        write: async request => {
          await assertCurrent();
          return params.store.update({ ...request, signal: context.signal, beforeWrite: assertCurrent });
        } });
    }
    if (actionId !== 'inbox.get') return clientActionUnavailable(actionId);
    const current = async () => {
      context.signal?.throwIfAborted();
      const admitted = context.expectedAccountId === params.accountId
        && (!context.serverId || await isServerProfileHomeIdentity(params.serverId, context.serverId))
        && (!params.isCurrent || await params.isCurrent());
      context.signal?.throwIfAborted();
      return admitted;
    };
    if (!await current()) return { ok: false, errorCode: 'credential_scope_retired', error: 'credential_scope_retired' };
    const items: ReturnType<typeof projectInboxReadItemV1>[] = [];
    const usageNoticeIds: string[] = [];
    // The server's indexed exact-kind selection returns only owned notice rows (plus its own
    // unclassified-legacy pass), so the read scales with notices, never with the Account's inventory.
    const listed = await params.store.list({ kinds: NOTICE_ARTIFACT_KINDS, ownerAccountId: params.accountId,
      ...(context.signal ? { signal: context.signal } : {}) });
    if (!await current()) return { ok: false, errorCode: 'credential_scope_retired', error: 'credential_scope_retired' };
    let noticeCoverage: 'complete' | 'partial' = listed.coverage === 'complete' ? 'complete' : 'partial';
    const selected = listed.items.filter(artifact => artifact.ownerAccountId === params.accountId && artifact.access === 'owner');
    // Header inventories do not carry exact-read exposure facts. Select owned
    // notice candidates here; readOwnedNoticeArtifactV1 admits only the batch's
    // authenticated private content, never a header's missing/claimed audience.
    const opened = await params.store.readBodies(selected, context.signal);
    if (!await current()) return { ok: false, errorCode: 'credential_scope_retired', error: 'credential_scope_retired' };
    for (const artifact of opened) {
      const admission = readOwnedNoticeArtifactAdmissionV1(artifact, params.accountId);
      if (admission.disposition === 'not_presented') continue;
      if (admission.disposition === 'unreadable') { noticeCoverage = 'partial'; continue; }
      // The Inbox deep link asks the app's existing detail registry to open the owning page.
      const header = normalizeAccountNoticeArtifactV1(admission.notice);
      const focus = inboxNoticeFocusKeyV1(params.serverId, artifact.artifactId);
      const item = projectAccountNoticeInboxItemV1({ artifactId: artifact.artifactId, serverId: params.serverId,
        createdAt: artifact.createdAt, header,
        pageRoute: `/inbox?item=${encodeURIComponent(focus)}` });
      if (item) {
        items.push(projectInboxReadItemV1(item));
        if (projectOpenUsageNoticeHeaderV1(header)) usageNoticeIds.push(artifact.artifactId);
      }
    }
    return AppShellActionOutputSchemas['inbox.get'].parse({ status: 'partial', groups: [], items,
      coverage: { discussions: 'unavailable', sources: [
        { source: 'notices', status: noticeCoverage, ...(noticeCoverage === 'partial' ? { reason: 'content_unavailable' } : {}) },
        { source: 'live_items', status: 'unavailable', reason: 'requires_app_projection' },
        { source: 'action_operations', status: 'unavailable', reason: 'device_local' },
        { source: 'friend_requests', status: 'unavailable', reason: 'requires_app_projection' },
      ] }, approvalIds: [], usageNoticeIds, accountNoticeIds: items.map(item => item.source.id), friendRequestIds: [],
      automationRunIds: [], readySessions: [], actionOperations: [], isLoading: false, refreshFailed: noticeCoverage !== 'complete' });
  };
}
