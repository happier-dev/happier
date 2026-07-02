import { z } from 'zod';
import { getGeneratedRuntimeDescriptorContributionV1 } from '../providers/runtimeDescriptorContributionsV1.js';

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

export function readRuntimeDescriptorV1ForProvider<TProviderId extends string>(
  value: unknown,
  providerId: TProviderId,
): RuntimeDescriptorEnvelopeV1<TProviderId> | null;
export function readRuntimeDescriptorV1ForProvider<TProviderId extends string>(
  value: unknown,
  providerId: TProviderId,
): RuntimeDescriptorEnvelopeV1<TProviderId> | null {
  const parsed = readRuntimeDescriptorV1(value);
  return parsed?.providerId === providerId ? parsed as RuntimeDescriptorEnvelopeV1<TProviderId> : null;
}

export function readCanonicalRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: string,
): Readonly<Record<string, unknown>> | null;
export function readCanonicalRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: string,
) {
  const contribution = getGeneratedRuntimeDescriptorContributionV1(providerId);
  if (!contribution) return null;
  const descriptor = readRuntimeDescriptorV1ForProvider(value, providerId);
  return contribution.readCanonicalDescriptor(descriptor) as Readonly<Record<string, unknown>> | null;
}

export const readCanonicalAgentRuntimeDescriptorV1ForProvider = readCanonicalRuntimeDescriptorV1ForProvider;
