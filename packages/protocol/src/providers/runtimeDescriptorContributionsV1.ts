/**
 * GENERATED FILE CONTRACT (A.16y.3-provider-session-control-and-runtime-descriptor-projections)
 * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import {
  buildCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
  type CanonicalCodexAgentRuntimeDescriptorV1,
  type CodexAgentRuntimeDescriptorV1,
} from './generated/runtime/descriptors/codex.js';
import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
  type CanonicalOpenCodeAgentRuntimeDescriptorV1,
  type OpenCodeAgentRuntimeDescriptorV1,
} from './generated/runtime/descriptors/opencode.js';
import {
  buildPiAgentRuntimeDescriptorV1,
  readCanonicalPiAgentRuntimeDescriptorV1,
  type CanonicalPiAgentRuntimeDescriptorV1,
  type PiAgentRuntimeDescriptorV1,
} from './generated/runtime/descriptors/pi.js';

export {
  buildCodexAgentRuntimeDescriptorV1,
  buildOpenCodeAgentRuntimeDescriptorV1,
  buildPiAgentRuntimeDescriptorV1,
};

export type {
  CanonicalCodexAgentRuntimeDescriptorV1,
  CodexAgentRuntimeDescriptorV1,
  CanonicalOpenCodeAgentRuntimeDescriptorV1,
  OpenCodeAgentRuntimeDescriptorV1,
  CanonicalPiAgentRuntimeDescriptorV1,
  PiAgentRuntimeDescriptorV1,
};

export const GENERATED_RUNTIME_DESCRIPTOR_PROVIDER_IDS_V1 = [
  'codex',
  'opencode',
  'pi',
] as const;

export type GeneratedRuntimeDescriptorProviderIdV1 =
  (typeof GENERATED_RUNTIME_DESCRIPTOR_PROVIDER_IDS_V1)[number];

export type GeneratedRuntimeDescriptorByProviderIdV1 = {
  codex: CodexAgentRuntimeDescriptorV1;
  opencode: OpenCodeAgentRuntimeDescriptorV1;
  pi: PiAgentRuntimeDescriptorV1;
};

export type GeneratedCanonicalRuntimeDescriptorByProviderIdV1 = {
  codex: CanonicalCodexAgentRuntimeDescriptorV1;
  opencode: CanonicalOpenCodeAgentRuntimeDescriptorV1;
  pi: CanonicalPiAgentRuntimeDescriptorV1;
};

type GeneratedRuntimeDescriptorContributionV1 = Readonly<{
  providerId: GeneratedRuntimeDescriptorProviderIdV1;
  readCanonicalDescriptor: (descriptor: unknown) => unknown;
}>;

export const GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1 = Object.freeze({
  codex: Object.freeze({
    providerId: 'codex',
    readCanonicalDescriptor: (descriptor: unknown) => readCanonicalCodexAgentRuntimeDescriptorV1(
      descriptor as CodexAgentRuntimeDescriptorV1 | null,
    ),
  }),
  opencode: Object.freeze({
    providerId: 'opencode',
    readCanonicalDescriptor: (descriptor: unknown) => readCanonicalOpenCodeAgentRuntimeDescriptorV1(
      descriptor as OpenCodeAgentRuntimeDescriptorV1 | null,
    ),
  }),
  pi: Object.freeze({
    providerId: 'pi',
    readCanonicalDescriptor: (descriptor: unknown) => readCanonicalPiAgentRuntimeDescriptorV1(
      descriptor as PiAgentRuntimeDescriptorV1 | null,
    ),
  }),
} satisfies {
  readonly [K in GeneratedRuntimeDescriptorProviderIdV1]: GeneratedRuntimeDescriptorContributionV1;
});

export function getGeneratedRuntimeDescriptorContributionV1<TProviderId extends GeneratedRuntimeDescriptorProviderIdV1>(
  providerId: TProviderId,
): GeneratedRuntimeDescriptorContributionV1;
export function getGeneratedRuntimeDescriptorContributionV1(
  providerId: string,
): GeneratedRuntimeDescriptorContributionV1 | null;
export function getGeneratedRuntimeDescriptorContributionV1(
  providerId: string,
): GeneratedRuntimeDescriptorContributionV1 | null {
  return Object.hasOwn(GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1, providerId)
    ? GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1[providerId as GeneratedRuntimeDescriptorProviderIdV1]
    : null;
}
