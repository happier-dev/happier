/**
 * GENERATED FILE CONTRACT (A.16y.3-provider-session-control-and-runtime-descriptor-projections)
 * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import {
  buildAntigravityRuntimeDescriptorV1,
  readCanonicalAntigravityRuntimeDescriptorV1,
  readStrictCanonicalAntigravityRuntimeDescriptorV1,
  type CanonicalAntigravityRuntimeDescriptorV1,
  type AntigravityRuntimeDescriptorV1,
} from './descriptors/antigravity.js';
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
  buildAntigravityRuntimeDescriptorV1,
  buildCodexAgentRuntimeDescriptorV1,
  buildOpenCodeAgentRuntimeDescriptorV1,
  buildPiAgentRuntimeDescriptorV1,
};

export type {
  CanonicalAntigravityRuntimeDescriptorV1,
  AntigravityRuntimeDescriptorV1,
  CanonicalCodexAgentRuntimeDescriptorV1,
  CodexAgentRuntimeDescriptorV1,
  CanonicalOpenCodeAgentRuntimeDescriptorV1,
  OpenCodeAgentRuntimeDescriptorV1,
  CanonicalPiAgentRuntimeDescriptorV1,
  PiAgentRuntimeDescriptorV1,
};

export const GENERATED_RUNTIME_DESCRIPTOR_PROVIDER_IDS_V1 = [
  'antigravity',
  'codex',
  'opencode',
  'pi',
] as const;

export type GeneratedRuntimeDescriptorProviderIdV1 =
  (typeof GENERATED_RUNTIME_DESCRIPTOR_PROVIDER_IDS_V1)[number];

export type GeneratedRuntimeDescriptorByProviderIdV1 = {
  antigravity: AntigravityRuntimeDescriptorV1;
  codex: CodexAgentRuntimeDescriptorV1;
  opencode: OpenCodeAgentRuntimeDescriptorV1;
  pi: PiAgentRuntimeDescriptorV1;
};

export type GeneratedCanonicalRuntimeDescriptorByProviderIdV1 = {
  antigravity: CanonicalAntigravityRuntimeDescriptorV1;
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
  antigravity: Object.freeze({
    agentId: 'antigravity',
    readCanonicalDescriptor: (descriptor: unknown) => readCanonicalAntigravityRuntimeDescriptorV1(
      descriptor as AntigravityRuntimeDescriptorV1 | null,
    ),
    readStrictCanonicalDescriptor: (descriptor: unknown) => readStrictCanonicalAntigravityRuntimeDescriptorV1(
      descriptor as AntigravityRuntimeDescriptorV1 | null,
    ),
  }),
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
