import { describe, expect, it } from 'vitest';

import * as protocolRoot from '../../index.js';
import { computePluginUiArtifactSha256DigestV1 } from './artifactIntegrity.js';
import { derivePluginUiNativeCapabilitiesDigestV1 } from './artifactCompatibility.js';

describe('Plugin UI artifact compatibility', () => {
  it('derives native capability identity from the trimmed, sorted compatibility set', () => {
    const expected = computePluginUiArtifactSha256DigestV1(
      new TextEncoder().encode(JSON.stringify(['clipboard', 'haptics'])),
    );

    expect(derivePluginUiNativeCapabilitiesDigestV1([
      ' haptics ',
      'clipboard',
      '  ',
    ])).toBe(expected);
  });

  it('publishes the canonical digest helper through the Protocol root', () => {
    expect(protocolRoot.derivePluginUiNativeCapabilitiesDigestV1)
      .toBe(derivePluginUiNativeCapabilitiesDigestV1);
  });
});
