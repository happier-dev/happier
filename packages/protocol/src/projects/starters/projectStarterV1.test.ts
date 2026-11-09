import { describe, expect, it, vi } from 'vitest';
import {
  ProjectStarterV1Schema, ProjectStarterCatalogV1Schema,
  getBundledProjectStartersV1, resolveBundledProjectStarterV1,
} from '../../index.js';

const starter = {
  schemaVersion: 1,
  id: 'static-website',
  titleKey: 'projectStarters.staticWebsite.title',
  summaryKey: 'projectStarters.staticWebsite.summary',
  technologyLabels: ['HTML', 'CSS'],
  previewAssetKey: 'project-starter-static-website',
  repository: {
    selector: {
      provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'mdn/beginner-html-site-styled', cloneUrl: 'https://github.com/mdn/beginner-html-site-styled.git' },
      protocol: 'https',
    },
    ref: '6c7a360ddb4a0d75be06044bf8a914f260ff10c7',
  },
  buildGoal: 'Build a responsive website from this HTML and CSS example. Replace the sample Mozilla text and logo with original content and use HTTPS for external resources.',
  appShape: 'static',
  deploymentSupport: 'platformOnly',
};

describe('Project starter catalog admission', () => {
  it('admits a pinned whole-repository descriptor through the public Protocol owner', () => {
    expect(ProjectStarterV1Schema.parse(starter)).toEqual(starter);
  });

  it('admits full SHA-256 pins supported by the canonical SCM commit owner', () => {
    expect(ProjectStarterV1Schema.safeParse({ ...starter, repository: { ...starter.repository, ref: 'a'.repeat(64) } }).success).toBe(true);
  });

  it('refuses mutable refs, unsupported versions, credentials, subdirectories and unknown fields', () => {
    expect(ProjectStarterV1Schema.safeParse(starter).success).toBe(true);
    const selector = starter.repository.selector;
    for (const invalid of [
      { ...starter, schemaVersion: 2 },
      { ...starter, subdir: 'site' },
      { ...starter, repository: { ...starter.repository, subdir: 'site' } },
      { ...starter, repository: { ...starter.repository, ref: 'main' } },
      { ...starter, repository: { ...starter.repository, ref: 'v1.0.0' } },
      { ...starter, repository: { ...starter.repository, ref: '6c7a360' } },
      { ...starter, repository: { ...starter.repository, selector: { ...selector, subdir: 'site' } } },
      { ...starter, repository: { ...starter.repository, selector: { ...selector, provider: { ...selector.provider, baseUrl: 'https://user@github.com' } } } },
      { ...starter, repository: { ...starter.repository, selector: { ...selector, provider: { ...selector.provider, baseUrl: 'http://github.com' } } } },
      { ...starter, repository: { ...starter.repository, selector: { ...selector, repository: { ...selector.repository, subdirectory: 'site' } } } },
      { ...starter, repository: { ...starter.repository, selector: { ...selector, repository: { ...selector.repository, cloneUrl: 'https://user:password@github.com/mdn/beginner-html-site-styled.git' } } } },
      { ...starter, repository: { ...starter.repository, selector: { ...selector, repository: { ...selector.repository, cloneUrl: 'http://github.com/mdn/beginner-html-site-styled.git' } } } },
      { ...starter, deploymentSupport: 'ownServerReady', appShape: 'unknown' },
      { ...starter, authorization: 'caller-minted' },
    ]) expect(ProjectStarterV1Schema.safeParse(invalid).success).toBe(false);
    expect(ProjectStarterCatalogV1Schema.safeParse([starter, starter]).success).toBe(false);
  });

  it('bundles actual immutable data and resolves only known ids without rebuilding descriptors', () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const catalog = getBundledProjectStartersV1();
      expect(catalog.length).toBeGreaterThan(0);
      expect(ProjectStarterCatalogV1Schema.safeParse(catalog).success).toBe(true);
      for (let read = 0; read < 1000; read++) {
        expect(getBundledProjectStartersV1()).toBe(catalog);
        expect(resolveBundledProjectStarterV1('static-website')).toBe(catalog[0]);
      }
      expect(network).not.toHaveBeenCalled();
      expect(resolveBundledProjectStarterV1('unknown-starter')).toBeNull();
      expect(Object.isFrozen(catalog)).toBe(true);
      expect(Object.isFrozen(catalog[0].repository.selector.repository)).toBe(true);
    } finally { network.mockRestore(); }
  });
});
