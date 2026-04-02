import { describe, expect, it } from 'vitest';

import { normalizeBootstrapChannel } from './taskRuntime.js';

describe('normalizeBootstrapChannel', () => {
  it('maps preview to preview', () => {
    expect(normalizeBootstrapChannel('preview')).toEqual({
      commandChannel: 'preview',
      releaseChannel: 'preview',
    });
  });

  it('maps dev to publicdev', () => {
    expect(normalizeBootstrapChannel('dev')).toEqual({
      commandChannel: 'dev',
      releaseChannel: 'publicdev',
    });
  });

  it('accepts publicdev alias inputs for dev', () => {
    expect(normalizeBootstrapChannel('publicdev')).toEqual({
      commandChannel: 'dev',
      releaseChannel: 'publicdev',
    });
    expect(normalizeBootstrapChannel('public-dev')).toEqual({
      commandChannel: 'dev',
      releaseChannel: 'publicdev',
    });
    expect(normalizeBootstrapChannel('public_dev')).toEqual({
      commandChannel: 'dev',
      releaseChannel: 'publicdev',
    });
  });

  it('defaults to stable', () => {
    expect(normalizeBootstrapChannel('')).toEqual({
      commandChannel: 'stable',
      releaseChannel: 'stable',
    });
    expect(normalizeBootstrapChannel('stable')).toEqual({
      commandChannel: 'stable',
      releaseChannel: 'stable',
    });
    expect(normalizeBootstrapChannel('unknown')).toEqual({
      commandChannel: 'stable',
      releaseChannel: 'stable',
    });
  });
});
