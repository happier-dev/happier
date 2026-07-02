import { z } from 'zod';

export const SERVER_IDENTITY_ID_PATTERN = /^srv_[A-Za-z0-9._-]{1,60}$/;

export function normalizeServerIdentityIdCapability(value: unknown): string | null | undefined {
  if (value == null) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return SERVER_IDENTITY_ID_PATTERN.test(trimmed) ? trimmed : null;
}

const ServerIdentityIdSchema = z.preprocess(
  normalizeServerIdentityIdCapability,
  z.string().nullable().optional().default(null),
);

export const ServerIdentityCapabilitiesSchema = z.object({
  serverIdentityId: ServerIdentityIdSchema,
});

export type ServerIdentityCapabilities = z.infer<typeof ServerIdentityCapabilitiesSchema>;

export const DEFAULT_SERVER_IDENTITY_CAPABILITIES: ServerIdentityCapabilities = {
  serverIdentityId: null,
};
