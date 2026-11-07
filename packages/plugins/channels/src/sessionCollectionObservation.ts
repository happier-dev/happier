import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { CHANNEL_DELIVERIES_COLLECTION, CHANNEL_DELIVERIES_INDEX_ID, CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { conversationSessionBindingSelection, readConversationSessionBindingDeliveryTargets } from './accountLocalBindingPolicy.js';
import { readSessionPullRequestBindingRows, sessionPullRequestBindingSelection } from './sessionPullRequestBindings.js';
import { createChannelsCollectionAccess } from './collectionUpdateRequired.js';

/** Content-free watches follow the selected Session's currently admitted membership. */
export async function observeConversationSessionCollections(invalidate: () => void, input: Readonly<{
  accountStorage: PluginAccountStorageScope;
  sessionId: string;
  signal: AbortSignal;
  scope: 'outward' | 'conversations' | 'pullRequestWatch';
}>) {
  const access = createChannelsCollectionAccess(input.accountStorage);
  const state = access.storage.collection(CHANNEL_STATE_COLLECTION);
  const deliveries = input.scope === 'pullRequestWatch' ? undefined : access.storage.collection(CHANNEL_DELIVERIES_COLLECTION);
  const dependencies = new Map<string, { dispose(): void }>();
  let disposed = input.signal.aborted;
  let pending = false;
  let reading = false;
  const notify = () => { if (!disposed && !input.signal.aborted) invalidate(); };
  async function refresh() {
    pending = true;
    if (reading || disposed) return;
    reading = true;
    try {
      while (pending && !disposed && !input.signal.aborted) {
        pending = false;
        const selection = { collection: state, sessionId: input.sessionId, signal: input.signal };
        const targets = input.scope === 'pullRequestWatch'
          ? (await readSessionPullRequestBindingRows(selection))
            .map(({ binding }) => ({ bindingId: binding.id, connectionId: binding.connectionId }))
          : await readConversationSessionBindingDeliveryTargets(selection);
        if (disposed || input.signal.aborted) break;
        const wanted = new Map<string, () => { dispose(): void }>();
        for (const target of targets) {
          if (deliveries) wanted.set(`delivery:${target.bindingId}`, () => deliveries.watch({
            index: CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
            prefix: [target.connectionId, target.bindingId], order: 'asc',
          }, notify));
          if (input.scope === 'outward') continue;
          wanted.set(`connection:${target.connectionId}`, () => state.watch({
            index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
            prefix: [target.connectionId, null, CHANNEL_STATE_RECORD_KIND.connection], order: 'asc',
          }, notify));
          if (input.scope === 'pullRequestWatch') continue;
          wanted.set(`conflict:${target.connectionId}`, () => state.watch({
            index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
            prefix: [target.connectionId, null, CHANNEL_STATE_RECORD_KIND.ingressCensus, true], order: 'asc',
          }, notify));
          wanted.set(`frontier:${target.bindingId}`, () => state.watch({
            index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
            prefix: [null, target.bindingId, CHANNEL_STATE_RECORD_KIND.projectionFrontier], order: 'asc',
          }, notify));
        }
        for (const [key, observation] of dependencies) {
          if (wanted.has(key)) continue;
          observation.dispose();
          dependencies.delete(key);
        }
        for (const [key, observe] of wanted) {
          if (dependencies.has(key)) continue;
          dependencies.set(key, observe());
        }
      }
    } catch {
      if (access.updateRequired !== undefined) {
        // Publish the settled refusal once, then retire this observer. Row and
        // reset hints cannot update its compiled Collection contract; a new
        // Resource activation owns the next admitted membership read.
        notify();
        dispose();
        return;
      }
      // The subsequent Resource read owns the typed migration/storage failure.
      // Retire dependencies rather than continuing with an unverified membership.
      for (const observation of dependencies.values()) observation.dispose();
      dependencies.clear();
      notify();
    } finally {
      reading = false;
    }
  }
  const membership = state.watch(input.scope === 'pullRequestWatch'
    ? sessionPullRequestBindingSelection({ sessionId: input.sessionId })
    : conversationSessionBindingSelection(input.sessionId), () => {
    notify();
    void refresh();
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    membership.dispose();
    for (const observation of dependencies.values()) observation.dispose();
    dependencies.clear();
    input.signal.removeEventListener('abort', dispose);
  }
  if (disposed) membership.dispose();
  else {
    input.signal.addEventListener('abort', dispose, { once: true });
    // An observer is acquired only after its initial dependencies are attached.
    // The caller's first read then covers the acquisition gap without a fake change.
    await refresh();
  }
  return { dispose };
}
