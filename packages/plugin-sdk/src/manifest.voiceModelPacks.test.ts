import { describe, expect, it } from 'vitest';

import * as browserRoot from './index.browser.js';
import * as browserManifest from './manifest.browser.js';
import * as manifestSdk from './manifest.js';
import * as voiceModelPacks from './manifest/voiceModelPacks.js';

describe('public voice model-pack manifest SDK', () => {
  it('isolates the versioned declarative schema under an experimental module', () => {
    expect(typeof voiceModelPacks.VoiceModelPackContributionV1Schema).toBe('object');
    expect(manifestSdk).not.toHaveProperty('VoiceModelPackContributionV1Schema');
    expect(manifestSdk).not.toHaveProperty('registerVoiceModelPack');
    expect(manifestSdk).not.toHaveProperty('registerVoiceProvider');
  });

  it('keeps versioned declarative schemas off the normal browser condition', () => {
    expect(browserManifest).not.toHaveProperty('VoiceModelPackExecutionHostV1Schema');
    expect(browserManifest).not.toHaveProperty('VoiceModelPackContributionV1Schema');
    expect(browserRoot).not.toHaveProperty('VoiceModelPackContributionV1Schema');
    expect(browserRoot).not.toHaveProperty('VoiceModelPackRuntimeV1Schema');
  });
});
