import { z } from 'zod';

import {
  SESSION_ORGANIZATION_LABEL_KINDS,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
  SESSION_ORGANIZATION_ORDER_ITEM_KINDS,
  SESSION_ORGANIZATION_ORDER_SCOPE_KINDS,
} from './constants.js';
import { SessionOrganizationContentEnvelopeSchema } from './content.js';
import { lazySchema } from '../lazySchema.js';

const SessionOrganizationScopeKeySchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH));
const SessionOrganizationItemKeySchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH));
const SessionOrganizationSortKeySchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH));

export const SessionOrganizationOrderScopeKindSchema = lazySchema(() => z.enum(SESSION_ORGANIZATION_ORDER_SCOPE_KINDS));
export type SessionOrganizationOrderScopeKind = z.infer<typeof SessionOrganizationOrderScopeKindSchema>;

export const SessionOrganizationOrderItemKindSchema = lazySchema(() => z.enum(SESSION_ORGANIZATION_ORDER_ITEM_KINDS));
export type SessionOrganizationOrderItemKind = z.infer<typeof SessionOrganizationOrderItemKindSchema>;

export const SessionOrganizationOrderEntrySchema = lazySchema(() => z
  .object({
    scopeKind: SessionOrganizationOrderScopeKindSchema,
    scopeKey: SessionOrganizationScopeKeySchema,
    itemKind: SessionOrganizationOrderItemKindSchema,
    itemKey: SessionOrganizationItemKeySchema,
    sortKey: SessionOrganizationSortKeySchema,
  })
  .strict());
export type SessionOrganizationOrderEntry = z.infer<typeof SessionOrganizationOrderEntrySchema>;

export const SessionOrganizationLabelKindSchema = lazySchema(() => z.enum(SESSION_ORGANIZATION_LABEL_KINDS));
export type SessionOrganizationLabelKind = z.infer<typeof SessionOrganizationLabelKindSchema>;

export const SessionOrganizationLabelSchema = lazySchema(() => z
  .object({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationScopeKeySchema,
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
    archivedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionOrganizationLabel = z.infer<typeof SessionOrganizationLabelSchema>;
