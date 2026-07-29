import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('DeepSec strict plugin manifest', () => {
  it('owns both execution-run profiles and discloses its finite environment dependency', () => {
    const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingestion.ok, JSON.stringify(ingestion)).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      id: 'deepsec', runtime: { kind: 'custom' }, primary: 'executionRuns',
    });
    expect(PLUGIN_MANIFEST.contributes.executionRunProfiles.map((profile) => profile.id)).toEqual([
      'review', 'repository-security-audit',
    ]);
    expect(PLUGIN_MANIFEST.contributes.executionRunProfiles.every((profile) => (
      profile.actions?.some((action) => (
        action.kind === 'hostAction' && action.actionId === 'reviews.comments.create'
      )) === true
    ))).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.actions ?? []).toEqual([]);
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'deepsec-workspace',
        capability: 'filesystem',
        scope: { locations: [{ root: 'workspace' }], access: ['read'] },
      }),
      expect.objectContaining({ id: 'ai-gateway-api-key', capability: 'environment' }),
      expect.objectContaining({ id: 'deepsec-process', capability: 'process' }),
    ]));
  });
});
