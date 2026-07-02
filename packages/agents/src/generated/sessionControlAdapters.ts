/**
 * GENERATED FILE CONTRACT (A.16y.3-provider-session-control-and-runtime-descriptor-projections)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import {
  createRuntimeDescriptorResumeIdSessionControlAdapter,
} from '../runtime/controlSurface/runtimeDescriptorResume.js';
import { CODEX_SESSION_CONTROL_ADAPTER } from '../providers/codex/sessionControlAdapter.js';
import { OPENCODE_SESSION_CONTROL_ADAPTER } from '../providers/opencode/sessionControlAdapter.js';
import type { ProviderSessionControlAdapter } from '../runtime/controlSurface/types.js';

export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS = [
  'codex',
  'opencode',
  'pi',
] as const;

export type GeneratedProviderSessionControlAdapterProviderId =
  (typeof GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS)[number];

export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS: Readonly<Record<GeneratedProviderSessionControlAdapterProviderId, ProviderSessionControlAdapter>> = Object.freeze({
  codex: CODEX_SESSION_CONTROL_ADAPTER,
  opencode: OPENCODE_SESSION_CONTROL_ADAPTER,
  pi: createRuntimeDescriptorResumeIdSessionControlAdapter({
    providerId: 'pi',
    absolutePathField: 'sessionFile',
    fallbackField: 'providerSessionId',
  }),
});
