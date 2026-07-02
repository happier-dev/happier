/**
 * GENERATED FILE CONTRACT (A.16y.3-provider-session-control-and-runtime-descriptor-projections)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import {
  createProviderSessionIdRuntimeDescriptorReader,
} from '../runtime/identity/providerSessionIdReader.js';
import { readCodexSessionMetadataRuntimeDescriptor } from '../providers/codex/readSessionMetadataRuntimeDescriptor.js';
import { readOpenCodeSessionMetadataRuntimeDescriptor } from '../providers/opencode/readSessionMetadataRuntimeDescriptor.js';
import type { RuntimeDescriptorReaderMap } from '../runtime/identity/runtimeDescriptorTypes.js';

export const GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS = [
  'codex',
  'opencode',
  'pi',
] as const;

export type GeneratedRuntimeDescriptorReaderProviderId =
  (typeof GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS)[number];

export const GENERATED_RUNTIME_DESCRIPTOR_READERS: Readonly<Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>> = Object.freeze({
  codex: readCodexSessionMetadataRuntimeDescriptor,
  opencode: readOpenCodeSessionMetadataRuntimeDescriptor,
  pi: createProviderSessionIdRuntimeDescriptorReader({
    providerId: 'pi',
    runtimeHandle: 'providerSessionId',
  }),
});
