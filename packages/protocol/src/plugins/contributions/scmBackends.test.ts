import { describe, expect, it } from 'vitest';

import { PluginManifestV2Schema } from '../manifest/v2.js';
import { ScmBackendContributionSchema } from './scmBackends.js';

describe('SCM backend plugin contribution schema', () => {
  it('accepts a strict non-Agent backend descriptor through the canonical manifest', () => {
    const parsed = PluginManifestV2Schema.parse({
      schemaVersion: 2,
      id: 'acme.scm.backend',
      version: '1.0.0',
      displayName: 'Acme SCM Backend',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        scmBackends: [{
          id: 'acme-vcs',
          title: 'Acme VCS',
          description: 'Acme local source control.',
          kind: 'acme',
          capabilities: ['detect', 'status', 'diff', 'commit'],
          metadata: { repositoryMarker: '.acme' },
        }],
      },
    });

    expect(parsed.contributes.scmBackends).toEqual([{
      id: 'acme-vcs',
      title: 'Acme VCS',
      description: 'Acme local source control.',
      kind: 'acme',
      capabilities: ['detect', 'status', 'diff', 'commit'],
      metadata: { repositoryMarker: '.acme' },
    }]);
    expect(parsed.contributes.agents).toEqual([]);
    expect('backends' in parsed.contributes).toBe(false);
  });

  it('rejects retired transport/runtime vocabulary in the cold manifest descriptor', () => {
    expect(ScmBackendContributionSchema.safeParse({
      id: 'acme-vcs',
      title: 'Acme VCS',
      kind: 'acme',
      capabilities: ['detect'],
      repoModes: ['.git'],
      detection: { rootMarkers: ['.acme'] },
      tooling: { commands: [] },
      sourceController: {},
    }).success).toBe(false);
  });

  it('requires at least one unique declared operation', () => {
    const base = {
      id: 'acme-vcs',
      title: 'Acme VCS',
      kind: 'acme',
    };

    expect(ScmBackendContributionSchema.safeParse({
      ...base,
      capabilities: [],
    }).success).toBe(false);
    expect(ScmBackendContributionSchema.safeParse({
      ...base,
      capabilities: ['status', 'status'],
    }).success).toBe(false);
  });
});
