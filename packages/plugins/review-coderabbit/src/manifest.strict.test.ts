import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('CodeRabbit strict plugin manifest', () => {
  it('owns an execution-run profile through declared prompt/resource/action references', () => {
    const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingestion.ok, JSON.stringify(ingestion)).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      id: 'coderabbit', runtime: { kind: 'custom' }, primary: 'executionRuns',
    });
    expect(PLUGIN_MANIFEST.contributes.executionRunProfiles[0]).toMatchObject({
      id: 'review', intent: 'review', promptAsset: 'review-prompt',
      defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
    });
    expect(PLUGIN_MANIFEST.contributes.actions ?? []).toEqual([]);
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      capability: 'filesystem',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }));
  });
});
