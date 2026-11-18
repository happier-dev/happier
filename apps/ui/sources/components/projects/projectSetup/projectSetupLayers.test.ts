import { describe, expect, it } from 'vitest';
import { resolveProjectDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';

import { t } from '@/text';

import { listProjectSetupEffect } from './ProjectSetupReview';
import { readProjectSetupLayers } from './projectSetupLayers';

const definition = resolveProjectDefinitionV1({
  repositoryManifest: {
    version: 1,
    toolchain: { kind: 'toolchain', tool: 'mise' },
    scripts: { lint: { source: { kind: 'command', command: 'lint repository' } } },
  },
  acceptedSharedSetup: {
    sourceId: 'src-acme-web',
    contentRevision: { headerVersion: 1, bodyVersion: 3 },
    digest: 'a'.repeat(64),
    manifest: { version: 1, workspace: {
      setup: [{ kind: 'command', command: './scripts/seed-dev.sh --orders 500' }],
    } },
  },
  setupOverrides: {
    version: 1,
    services: { redis: { source: { kind: 'command', command: 'redis-server' } } },
    scripts: { lint: { source: { kind: 'command', command: 'lint personal' } } },
  },
});
const manifest = definition.effectiveManifest;
if (!manifest) throw new Error('Expected the authored Project layers to compose');

describe('project setup layers (plan A L6)', () => {
  it('names the layer that decides each review line, and lists services only for the update review', () => {
    const layers = readProjectSetupLayers(definition, 'Acme web setup');
    const lines = listProjectSetupEffect(manifest, undefined, {
      layerOf: layers.layerOf,
      services: true,
    });
    expect(lines.map((line) => [line.key, line.origin])).toEqual([
      ['tools', t('projects.scripts.layer.repository')],
      ['step:0', 'Acme web setup'],
      ['service:redis', t('projects.scripts.layer.personal')],
    ]);
    expect(listProjectSetupEffect(manifest).map((line) => line.key)).toEqual([
      'tools',
      'step:0',
    ]);
    expect(
      listProjectSetupEffect(manifest).every(
        (line) => line.origin === undefined,
      ),
    ).toBe(true);
  });

  it('counts changes just for you without the repository declarations they override', () => {
    const layers = readProjectSetupLayers(definition, null);
    expect(layers.personalChanges).toBe(2);
    expect(layers.sharedSourceId).toBe('src-acme-web');
    expect(layers.originOf(['scripts', 'lint'])).toBe(
      t('projects.scripts.origin.personal'),
    );
    expect(layers.originOf(['scripts', 'test'])).toBeNull();
  });
});
