import { describe, expect, it } from 'vitest';

import {
  readCodexSessionMetadataRuntimeDescriptor,
} from './codex/readSessionMetadataRuntimeDescriptor.js';
import {
  readOpenCodeSessionMetadataRuntimeDescriptor,
} from './opencode/readSessionMetadataRuntimeDescriptor.js';
import { readPiSessionMetadataRuntimeDescriptor } from './pi/readSessionMetadataRuntimeDescriptor.js';
import {
  PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  getProviderRuntimeDescriptorReader,
} from './runtimeDescriptorReaderRegistry.js';

describe('runtimeDescriptorReaderRegistry', () => {
  it('exposes only the providers that own runtime descriptor readers', () => {
    expect(PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
  });

  it('routes each supported provider id to its provider-owned reader', () => {
    expect(getProviderRuntimeDescriptorReader('codex')).toBe(readCodexSessionMetadataRuntimeDescriptor);
    expect(getProviderRuntimeDescriptorReader('opencode')).toBe(readOpenCodeSessionMetadataRuntimeDescriptor);
    expect(getProviderRuntimeDescriptorReader('pi')).toBe(readPiSessionMetadataRuntimeDescriptor);
  });
});
