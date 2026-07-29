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
  readStrictCanonicalCodexAgentRuntimeDescriptorV1,
  type CanonicalCodexAgentRuntimeDescriptorV1,
  type CodexAgentRuntimeDescriptorV1,
} from './descriptors/codex.js';
import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
  readStrictCanonicalOpenCodeAgentRuntimeDescriptorV1,
  type CanonicalOpenCodeAgentRuntimeDescriptorV1,
  type OpenCodeAgentRuntimeDescriptorV1,
} from './descriptors/opencode.js';
import {
  buildPiAgentRuntimeDescriptorV1,
  readCanonicalPiAgentRuntimeDescriptorV1,
  readStrictCanonicalPiAgentRuntimeDescriptorV1,
  type CanonicalPiAgentRuntimeDescriptorV1,
  type PiAgentRuntimeDescriptorV1,
} from './descriptors/pi.js';

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
  agentId: GeneratedRuntimeDescriptorProviderIdV1;
  readCanonicalDescriptor: (descriptor: unknown) => unknown;
  readStrictCanonicalDescriptor: (descriptor: unknown) => unknown;
}>;

export const GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1 = Object.freeze({
  codex: Object.freeze({
    agentId: 'codex',
    readCanonicalDescriptor: (descriptor: unknown) => readCanonicalCodexAgentRuntimeDescriptorV1(
      descriptor as CodexAgentRuntimeDescriptorV1 | null,
    ),
    readStrictCanonicalDescriptor: (descriptor: unknown) => readStrictCanonicalCodexAgentRuntimeDescriptorV1(
      descriptor as CodexAgentRuntimeDescriptorV1 | null,
    ),
  }),
  opencode: Object.freeze({
    agentId: 'opencode',
    readCanonicalDescriptor: (descriptor: unknown) => readCanonicalOpenCodeAgentRuntimeDescriptorV1(
      descriptor as OpenCodeAgentRuntimeDescriptorV1 | null,
    ),
    readStrictCanonicalDescriptor: (descriptor: unknown) => readStrictCanonicalOpenCodeAgentRuntimeDescriptorV1(
      descriptor as OpenCodeAgentRuntimeDescriptorV1 | null,
    ),
  }),
  pi: Object.freeze({
    agentId: 'pi',
    readCanonicalDescriptor: (descriptor: unknown) => readCanonicalPiAgentRuntimeDescriptorV1(
      descriptor as PiAgentRuntimeDescriptorV1 | null,
    ),
    readStrictCanonicalDescriptor: (descriptor: unknown) => readStrictCanonicalPiAgentRuntimeDescriptorV1(
      descriptor as PiAgentRuntimeDescriptorV1 | null,
    ),
  }),
} satisfies {
  readonly [K in GeneratedRuntimeDescriptorProviderIdV1]: GeneratedRuntimeDescriptorContributionV1;
});

export function getGeneratedRuntimeDescriptorContributionV1<TProviderId extends GeneratedRuntimeDescriptorProviderIdV1>(
  agentId: TProviderId,
): GeneratedRuntimeDescriptorContributionV1;
export function getGeneratedRuntimeDescriptorContributionV1(
  agentId: string,
): GeneratedRuntimeDescriptorContributionV1 | null;
export function getGeneratedRuntimeDescriptorContributionV1(
  agentId: string,
): GeneratedRuntimeDescriptorContributionV1 | null {
  return Object.hasOwn(GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1, agentId)
    ? GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1[agentId as GeneratedRuntimeDescriptorProviderIdV1]
    : null;
}
