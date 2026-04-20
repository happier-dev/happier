import { z } from 'zod';
import {
  buildCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
  type CanonicalCodexAgentRuntimeDescriptorV1,
  type CodexAgentRuntimeDescriptorV1,
} from '../providers/codex/runtimeDescriptorV1.js';
import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
  type CanonicalOpenCodeAgentRuntimeDescriptorV1,
  type OpenCodeAgentRuntimeDescriptorV1,
} from '../providers/opencode/runtimeDescriptorV1.js';
import {
  buildPiAgentRuntimeDescriptorV1,
  readCanonicalPiAgentRuntimeDescriptorV1,
  type CanonicalPiAgentRuntimeDescriptorV1,
  type PiAgentRuntimeDescriptorV1,
} from '../providers/pi/runtimeDescriptorV1.js';

type RuntimeDescriptorProviderShape = Readonly<Record<string, unknown>>;

export type RuntimeDescriptorProviderExtraV1 = Readonly<{
  owner: string;
  schemaId: string;
  v: number;
} & Record<string, unknown>>;

export type RuntimeDescriptorEnvelopeV1<
  TProviderId extends string = string,
  TProvider extends RuntimeDescriptorProviderShape = RuntimeDescriptorProviderShape,
> = Readonly<{
  v: 1;
  providerId: TProviderId;
  provider: TProvider;
} & Record<string, unknown>>;

export type RuntimeDescriptorV1 = RuntimeDescriptorEnvelopeV1;

function createRuntimeDescriptorProviderSchema(zod: typeof z) {
  return zod.object({
    providerExtra: createRuntimeDescriptorProviderExtraV1Schema(zod).optional(),
  }).passthrough();
}

function createRuntimeDescriptorProviderExtraV1Schema(zod: typeof z) {
  return zod.object({
    owner: zod.string().min(1),
    schemaId: zod.string().min(1),
    v: zod.number().int().min(1),
  }).passthrough();
}

export function createRuntimeDescriptorV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    providerId: zod.string().min(1),
    provider: createRuntimeDescriptorProviderSchema(zod),
  }).passthrough();
}

export const RuntimeDescriptorV1Schema = createRuntimeDescriptorV1Schema(z);

export function readRuntimeDescriptorV1(value: unknown): RuntimeDescriptorV1 | null {
  const parsed = RuntimeDescriptorV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readRuntimeDescriptorV1ForProvider(value: unknown, providerId: 'codex'): CodexAgentRuntimeDescriptorV1 | null;
export function readRuntimeDescriptorV1ForProvider(value: unknown, providerId: 'opencode'): OpenCodeAgentRuntimeDescriptorV1 | null;
export function readRuntimeDescriptorV1ForProvider(value: unknown, providerId: 'pi'): PiAgentRuntimeDescriptorV1 | null;
export function readRuntimeDescriptorV1ForProvider<TProviderId extends string>(
  value: unknown,
  providerId: TProviderId,
): RuntimeDescriptorEnvelopeV1<TProviderId> | null {
  const parsed = readRuntimeDescriptorV1(value);
  return parsed?.providerId === providerId ? parsed as RuntimeDescriptorEnvelopeV1<TProviderId> : null;
}

export {
  buildCodexAgentRuntimeDescriptorV1,
  buildOpenCodeAgentRuntimeDescriptorV1,
  buildPiAgentRuntimeDescriptorV1,
};
export type {
  CodexAgentRuntimeDescriptorV1,
  OpenCodeAgentRuntimeDescriptorV1,
  PiAgentRuntimeDescriptorV1,
};

export {
  buildCodexAgentRuntimeDescriptorV1 as buildCodexRuntimeIdentityDescriptorV1,
  buildOpenCodeAgentRuntimeDescriptorV1 as buildOpenCodeRuntimeIdentityDescriptorV1,
  buildPiAgentRuntimeDescriptorV1 as buildPiRuntimeIdentityDescriptorV1,
};

type CanonicalRuntimeDescriptorByProviderId = {
  codex: CanonicalCodexAgentRuntimeDescriptorV1;
  opencode: CanonicalOpenCodeAgentRuntimeDescriptorV1;
  pi: CanonicalPiAgentRuntimeDescriptorV1;
};

export function readCanonicalRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'codex',
): CanonicalRuntimeDescriptorByProviderId['codex'] | null;
export function readCanonicalRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'opencode',
): CanonicalRuntimeDescriptorByProviderId['opencode'] | null;
export function readCanonicalRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'pi',
): CanonicalRuntimeDescriptorByProviderId['pi'] | null;
export function readCanonicalRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'codex' | 'opencode' | 'pi',
) {
  switch (providerId) {
    case 'codex':
      return readCanonicalCodexAgentRuntimeDescriptorV1(
        readRuntimeDescriptorV1ForProvider(value, 'codex') as CodexAgentRuntimeDescriptorV1 | null,
      );
    case 'opencode':
      return readCanonicalOpenCodeAgentRuntimeDescriptorV1(
        readRuntimeDescriptorV1ForProvider(value, 'opencode') as OpenCodeAgentRuntimeDescriptorV1 | null,
      );
    case 'pi':
      return readCanonicalPiAgentRuntimeDescriptorV1(
        readRuntimeDescriptorV1ForProvider(value, 'pi') as PiAgentRuntimeDescriptorV1 | null,
      );
  }
}

export const readCanonicalAgentRuntimeDescriptorV1ForProvider = readCanonicalRuntimeDescriptorV1ForProvider;
