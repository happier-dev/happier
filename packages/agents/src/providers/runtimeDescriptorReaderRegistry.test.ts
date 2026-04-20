import { describe, expect, it } from 'vitest';

import {
  readCodexSessionMetadataRuntimeDescriptor,
} from './codex/readSessionMetadataRuntimeDescriptor.js';
import {
  readOpenCodeSessionMetadataRuntimeDescriptor,
} from './opencode/readSessionMetadataRuntimeDescriptor.js';
import { readPiSessionMetadataRuntimeDescriptor } from './pi/readSessionMetadataRuntimeDescriptor.js';
import {
  RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  getRuntimeDescriptorReader,
  getProviderRuntimeDescriptorReader,
} from './runtimeDescriptorReaderRegistry.js';

describe('runtimeDescriptorReaderRegistry', () => {
  it('exposes only the providers that own runtime descriptor readers', () => {
    expect(RUNTIME_DESCRIPTOR_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
    expect(PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
  });

  it('routes each supported provider id to its provider-owned reader', () => {
    expect(getRuntimeDescriptorReader('codex')).toBe(readCodexSessionMetadataRuntimeDescriptor);
    expect(getRuntimeDescriptorReader('opencode')).toBe(readOpenCodeSessionMetadataRuntimeDescriptor);
    expect(getRuntimeDescriptorReader('pi')).toBe(readPiSessionMetadataRuntimeDescriptor);
    expect(getProviderRuntimeDescriptorReader('codex')).toBe(readCodexSessionMetadataRuntimeDescriptor);
    expect(getProviderRuntimeDescriptorReader('opencode')).toBe(readOpenCodeSessionMetadataRuntimeDescriptor);
    expect(getProviderRuntimeDescriptorReader('pi')).toBe(readPiSessionMetadataRuntimeDescriptor);
  });

  it('treats non-record metadata as absent for provider-owned readers', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor(null as unknown as Record<string, unknown>)).toBeNull();
    expect(readPiSessionMetadataRuntimeDescriptor(null as unknown as Record<string, unknown>)).toBeNull();
  });
});
