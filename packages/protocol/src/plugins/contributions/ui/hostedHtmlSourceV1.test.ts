import { describe, expect, it } from 'vitest';
import { artifactHtmlBundleFromBodyV1 } from '../../../artifacts/artifactHtmlV1.js';
import { PluginHostedHtmlSourceV1Schema } from './hostedHtmlSourceV1.js';

describe('PluginHostedHtmlSourceV1Schema', () => {
  it('admits the canonical direct bundle and rejects the retired string wrapper', () => {
    const bundle = artifactHtmlBundleFromBodyV1('<main>Hello</main>');
    bundle.files['app.js'] = { mime: 'application/javascript', contentBase64: 'ZXhwb3J0IHt9' };
    expect(PluginHostedHtmlSourceV1Schema.safeParse(bundle).success).toBe(true);
    expect(PluginHostedHtmlSourceV1Schema.safeParse({ kind: 'html', html: '<main>Hello</main>' }).success).toBe(false);
    expect(PluginHostedHtmlSourceV1Schema.safeParse({ ...bundle, authority: 'installed' }).success).toBe(false);
  });

  it('does not apply an inline-string transport limit to valid bundle content', () => {
    expect(PluginHostedHtmlSourceV1Schema.safeParse(artifactHtmlBundleFromBodyV1('é'.repeat(524289))).success).toBe(true);
  });
});
