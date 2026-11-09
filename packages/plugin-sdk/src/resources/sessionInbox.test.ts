import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { PluginSessionInboxRowPageV1Schema } from './index.public.js';
import { createPluginTestkit } from '../testing/host.js';
import { externalSessionInboxPlugin, externalSessionInboxRow } from '../../fixtures/external-targeted-packages/target/src/sessionInboxAuthoring.js';

describe('external Session Inbox Resource authoring', () => {
  it('activates the authored producer and consumes its bytes through the public strict page reader', async () => {
    const testkit = await createPluginTestkit({ manifest: externalSessionInboxPlugin.manifest, module: externalSessionInboxPlugin });
    try {
      const runtime = testkit.registration('resources', 'inbox');
      if (!runtime) throw new Error('Authored Inbox Resource was not activated');
      const bytes = await runtime.read(createTestResourceInvocationContext({ signal: new AbortController().signal,
        context: { kind: 'surface', mountInstanceKey: 'happier:session-inbox', launchInput: { cursor: null, serverId: 'home' } },
      }));
      const page = PluginSessionInboxRowPageV1Schema.parse(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)));
      expect(page).toEqual({ kind: 'ready', rows: [externalSessionInboxRow], nextCursor: null });
      expect(page).toMatchObject({ rows: [{ landing: { number: 42, state: 'open',
        url: 'https://forge.example/acme/app/pull/42', observedAt: 10 } }] });
      expect(externalSessionInboxPlugin.manifest.contributes.resources).toMatchObject([
        { id: 'inbox', scope: 'surface', sessionInbox: { detailResourceId: 'detail' } },
        { id: 'detail', scope: 'session' },
      ]);
    } finally { await testkit.dispose(); }
  });
});
