import { describe, expect, it } from 'vitest';
import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { PluginUiReviewContextV1Schema } from '@happier-dev/protocol/plugins/ui';
import { PluginDeclarativeDocumentV1Schema } from '@happier-dev/protocol/plugins/contributions/ui';
import { SLICES_PLUGIN } from '../manifest.js';

describe('Slice review contributed presentation', () => {
  it('renders the opened namespaced finding through its ordinary registered Resource', async () => {
    const plugin = await createPluginTestkit({ manifest: SLICES_PLUGIN.manifest, module: SLICES_PLUGIN });
    try {
      const resource = plugin.registration('resources', 'review-presentation');
      expect(resource, 'the ordinary engine must register its demanded presentation').toBeDefined();
      const review = PluginUiReviewContextV1Schema.parse({ kind: 'finding', reviewId: 'review-42', commentId: 'comment-3',
        namespace: SLICES_PLUGIN.manifest.id, extension: { featureId: 'auth', confidence: 'high',
          reproduction: 'Sign out, then reload the workspace.', suggestedRegressionTest: 'Preserve the signed-out result.' } });
      const bytes = await resource!.read(createTestResourceInvocationContext({ context: {
        kind: 'surface', mountInstanceKey: 'opened-finding', launchInput: null, target: { kind: 'app' }, review,
      } }));
      const document = PluginDeclarativeDocumentV1Schema.parse(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)));
      expect(JSON.stringify(document)).toContain('Sign out, then reload the workspace.');
      expect(JSON.stringify(document)).toContain('Preserve the signed-out result.');
      expect(JSON.stringify(document)).toContain('auth');
    } finally { await plugin.dispose(); }
  });

  it.each([
    { context: { kind: 'engineOptions', engineId: 'happier.review.slices:slices', profileId: 'review',
      options: { provider: 'native', model: 'review-model', featureIds: ['auth', 'checkout'] } },
      expected: ['native', 'review-model', 'auth, checkout'] },
    { context: { kind: 'page', reviewId: 'review-42' }, expected: ['Slice evidence appears with each finding in this Review'] },
  ])('renders demanded $context.kind content through the same Resource', async ({ context, expected }) => {
    const plugin = await createPluginTestkit({ manifest: SLICES_PLUGIN.manifest, module: SLICES_PLUGIN });
    try {
      const resource = plugin.registration('resources', 'review-presentation');
      expect(resource).toBeDefined();
      const bytes = await resource!.read(createTestResourceInvocationContext({ context: {
        kind: 'surface', mountInstanceKey: 'opened-review', launchInput: null, target: { kind: 'app' },
        review: PluginUiReviewContextV1Schema.parse(context),
      } }));
      const document = PluginDeclarativeDocumentV1Schema.parse(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)));
      for (const value of expected) expect(JSON.stringify(document)).toContain(value);
    } finally { await plugin.dispose(); }
  });
});
