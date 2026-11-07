import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TRIAGE_PLUGIN } from '../manifest.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';

it('publishes source ingress under Triage with the exact destination and resolves the same item', async () => {
  // Inbox publication is the same automatic Account-local effect as background/Event delivery.
  expect(TRIAGE_PLUGIN.manifest.contributes.actions.find(action => action.id === 'attention/publish-v1'))
    .toMatchObject({ dangerLevel: 'safe', surfaces: ['plugin'] });
  const fixture = createTriageSourceV1Fixture();
  const { control, watchableCollections } = createTestkitCorpusCollections();
  control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
    sourceQualifiedId: `${fixture.configuredInstance.instance.source.pluginId}/${fixture.configuredInstance.instance.source.localId}`,
    lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured: fixture.configuredInstance }));
  const notices: Parameters<PluginInvocationContext['services']['notifications']['send']>[0][] = [];
  const context = { signal: new AbortController().signal, surface: 'plugin',
    plugin: { id: 'happier.triage', version: '0.0.0' },
    caller: { kind: 'plugin', pluginId: fixture.configuredInstance.instance.source.pluginId },
    services: { storage: { account: { collection: () => watchableCollections.sourceInstances } },
      targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
        contributor: { pluginId: fixture.configuredInstance.instance.source.pluginId, contributionId: fixture.configuredInstance.instance.source.localId },
        descriptor: fixture.descriptor,
      }] }), dispose() {} }) },
      notifications: { send: async (notice: typeof notices[number]) => { notices.push(notice); return { deliveries: [], replayed: false }; } },
    },
  } as unknown as PluginInvocationContext;
  const kit = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: TRIAGE_PLUGIN });
  try {
    const handler = kit.registration('actions', 'attention/publish-v1');
    expect(handler).toBeTypeOf('function');
    if (!handler) throw new Error('Target publisher must be registered');
    const input = { v: 1, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      entryRef: fixture.detailInput.observation.entryRef, reason: 'assignment', type: 'update', title: 'Assigned issue', resolved: false, clientRequestId: 'delivery-1' };
    expect(await handler(input, context)).toMatchObject({ kind: 'published' });
    expect(notices[0]).toMatchObject({ page: { pageId: 'triage', subPath: buildTriageEntryRouteSegmentV1(input.entryRef) }, resolved: false });
    expect(await handler({ ...input, resolved: true, clientRequestId: 'delivery-2' }, context)).toMatchObject({ kind: 'published' });
    expect(notices[1]).toMatchObject({ itemId: notices[0]?.itemId, resolved: true });
    expect(await handler(input, { ...context, caller: undefined })).toMatchObject({ kind: 'rejected' });
    expect(notices).toHaveLength(2);
  } finally { await kit.dispose(); }
});
