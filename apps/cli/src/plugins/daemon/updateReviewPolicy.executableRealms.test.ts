import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { hasPluginAuthorityExpansion, listPluginAuthorityExpansions } from './updateReviewPolicy';

function manifestWithRenderer(
  renderer: Readonly<Record<string, unknown>>,
  version = '1.0.0',
) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.ui-realms',
    version,
    contributes: {
      ui: {
        renderers: [{ ...renderer }],
      },
    },
  }));
  if (!parsed) throw new Error('Expected canonical UI renderer manifest');
  return parsed;
}

const DECLARATIVE_PANEL = Object.freeze({
  id: 'panel',
  kind: 'declarative',
  root: { kind: 'text', text: 'Panel' },
});
const HOSTED_WEB_PANEL = Object.freeze({
  id: 'panel',
  kind: 'hostedWeb',
  source: { kind: 'artifact', artifact: 'panel-web' },
});
const HOSTED_HTML_PANEL = Object.freeze({
  id: 'panel',
  kind: 'hostedHtml',
  source: artifactHtmlBundleFromBodyV1('<p>Hello</p>'),
});
const REACT_NATIVE_PANEL = Object.freeze({
  id: 'panel',
  kind: 'reactNative',
  artifact: 'panel-native',
});

function manifestWithRenderers(
  renderers: readonly Readonly<Record<string, unknown>>[],
  version = '1.0.0',
) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.ui-realms',
    version,
    contributes: {
      ui: {
        renderers: renderers.map((renderer) => ({ ...renderer })),
      },
    },
  }));
  if (!parsed) throw new Error('Expected canonical UI renderer manifest');
  return parsed;
}

/**
 * Plugins are trusted code: an update that ships a new executable realm or a
 * new contribution changes the plugin's bytes, not the authority the user
 * granted. Only user-granted reach (host access, Connected Account purposes,
 * request interceptors, raw credentials) reopens review.
 */
describe('hasPluginAuthorityExpansion ignores code-trust changes', () => {
  it.each([
    ['declarative to inline HTML', DECLARATIVE_PANEL, HOSTED_HTML_PANEL],
    ['hosted-web source form switch', HOSTED_WEB_PANEL, HOSTED_HTML_PANEL],
    ['declarative to hosted-web', DECLARATIVE_PANEL, HOSTED_WEB_PANEL],
    ['declarative to React Native', DECLARATIVE_PANEL, REACT_NATIVE_PANEL],
    ['unchanged hosted-web', HOSTED_WEB_PANEL, HOSTED_WEB_PANEL],
    ['executable back to declarative', HOSTED_WEB_PANEL, DECLARATIVE_PANEL],
  ] as const)('does not reopen review for a realm change: %s', (_label, previous, candidate) => {
    expect(listPluginAuthorityExpansions(
      manifestWithRenderer(previous),
      manifestWithRenderer(candidate, '1.0.1'),
      [],
    )).toEqual([]);
  });

  it('does not reopen review for a newly declared contribution', () => {
    expect(hasPluginAuthorityExpansion(
      manifestWithRenderers([DECLARATIVE_PANEL]),
      manifestWithRenderers([
        DECLARATIVE_PANEL,
        { ...REACT_NATIVE_PANEL, id: 'second-panel' },
      ], '1.0.1'),
      [],
    )).toBe(false);
  });
});
