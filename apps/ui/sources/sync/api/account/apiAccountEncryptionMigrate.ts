import { z } from 'zod';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';
import { AccountSettingsStoredContentEnvelopeSchema } from '@happier-dev/protocol';

const ConnectedServicesDirectiveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assert_empty') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z.object({
    action: z.literal('migrate'),
    credentials: z.array(z.unknown()),
  }).strict(),
]);

const AutomationsDirectiveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assert_empty') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z.object({
    action: z.literal('migrate'),
    templates: z.array(z.unknown()),
  }).strict(),
]);

export const AccountEncryptionMigrateRequestSchema = z.object({
  toMode: z.enum(['plain', 'e2ee']),
  expectedSettingsVersion: z.number().int().min(0),
  settingsContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
  connectedServices: ConnectedServicesDirectiveSchema,
  automations: AutomationsDirectiveSchema,
  keyProof: z.unknown().optional(),
}).strict();

export type AccountEncryptionMigrateRequest = z.infer<typeof AccountEncryptionMigrateRequestSchema>;

const AccountEncryptionMigrateSuccessSchema = z.object({
  success: z.literal(true),
  mode: z.enum(['plain', 'e2ee']),
  settingsVersion: z.number().int().min(0),
}).strict();

export async function migrateAccountEncryptionMode(
  credentials: AuthCredentials,
  request: AccountEncryptionMigrateRequest,
): Promise<z.infer<typeof AccountEncryptionMigrateSuccessSchema>> {
  return await backoff(async () => {
    const response = await serverFetch(
      '/v1/account/encryption/migrate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },
      { includeAuth: false },
    );

    const data: unknown = await response.json().catch(() => null);
    const success = AccountEncryptionMigrateSuccessSchema.safeParse(data);
    if (response.ok && success.success) {
      return success.data;
    }

    if (response.status === 404) {
      throw new HappyError('Encryption opt-out is not enabled on this server', false, {
        status: response.status,
        kind: 'config',
      });
    }

    throw new HappyError('Failed to update encryption setting', false, { status: response.status, kind: 'server' });
  });
}

