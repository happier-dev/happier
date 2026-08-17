import { z } from 'zod';

import {
  SESSION_ORGANIZATION_MAX_FOLDERS,
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_LABELS,
  SESSION_ORGANIZATION_MAX_TAGS,
} from './constants.js';
import { SessionOrganizationContentEnvelopeSchema } from './content.js';
import { SessionOrganizationLabelKindSchema } from './ordering.js';

const SessionOrganizationMigrationInventoryVersionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const SessionOrganizationAccountEncryptionMigrationInventorySchema = z
  .object({
    version: SessionOrganizationMigrationInventoryVersionSchema,
    folders: z.array(z.object({
      folderId: z.string().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH),
      display: SessionOrganizationContentEnvelopeSchema,
    }).strict()).max(SESSION_ORGANIZATION_MAX_FOLDERS),
    tags: z.array(z.object({
      tagId: z.string().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH),
      display: SessionOrganizationContentEnvelopeSchema,
    }).strict()).max(SESSION_ORGANIZATION_MAX_TAGS),
    labels: z.array(z.object({
      labelKind: SessionOrganizationLabelKindSchema,
      scopeKey: z.string().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH),
      display: SessionOrganizationContentEnvelopeSchema,
    }).strict()).max(SESSION_ORGANIZATION_MAX_LABELS),
  })
  .strict();

export type SessionOrganizationAccountEncryptionMigrationInventory = z.infer<
  typeof SessionOrganizationAccountEncryptionMigrationInventorySchema
>;
