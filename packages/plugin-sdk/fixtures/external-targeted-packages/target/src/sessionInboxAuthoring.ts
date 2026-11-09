import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginSessionInboxRowV1 } from '@happier-dev/plugin-sdk/resources';

export const externalSessionInboxRow = {
  id: 'review-42', session: { serverId: 'home', sessionId: 'session-42' },
  title: 'Review deployment', detail: null,
  landing: { number: 42, url: 'https://forge.example/acme/app/pull/42', state: 'open', observedAt: 10 },
  detailResource: { pluginId: 'com.acme.inbox', resourceId: 'detail' },
  controls: [
    { id: 'Allow', label: { key: 'deployment.allow', fallback: 'Allow' }, effect: {
      kind: 'open', page: { pageId: 'deployment-review', subPath: 'deployments/42' },
    } },
    { id: 'Deny', label: { key: 'deployment.deny', fallback: 'Deny' }, effect: {
      kind: 'open', page: { pageId: 'deployment-review', subPath: 'deployments/42' },
    } },
    { id: 'Continue #42 ✨', label: { key: 'watch.continue', fallback: 'Continue' }, effect: {
      kind: 'action', invocation: { action: { pluginId: 'com.acme.watch', localId: 'continue' },
        input: { sessionId: 'session-42', expectedRevision: 4 } },
    } },
  ],
} satisfies PluginSessionInboxRowV1;

/** External authors publish data only; the host owns every control press. */
export const externalSessionInboxPlugin = definePlugin({
  id: 'com.acme.inbox', version: '1.0.0',
  resources: {
    inbox: { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface',
      sessionInbox: { detailResourceId: 'detail' }, runtime: {
        read: () => JSON.stringify({ kind: 'ready', rows: [externalSessionInboxRow], nextCursor: null }),
        observe: () => ({ dispose() {} }),
      } },
    detail: { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'session', runtime: {
      read: () => JSON.stringify({ title: 'Review deployment' }), observe: () => ({ dispose() {} }),
    } },
  },
});
