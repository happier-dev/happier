import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import {
  SESSION_ORGANIZATION_LABEL_KINDS,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
  SESSION_ORGANIZATION_ORDER_ITEM_KINDS,
  SESSION_ORGANIZATION_ORDER_SCOPE_KINDS,
} from './constants.js';
import {
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationDisplayStateSchema,
} from './contentSchemas.js';

const SessionOrganizationScopeKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)));
const SessionOrganizationItemKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH)));

export const SessionOrganizationOrderScopeKindSchema = lazyZodSchema(() => z.enum(SESSION_ORGANIZATION_ORDER_SCOPE_KINDS));
export type SessionOrganizationOrderScopeKind = z.infer<typeof SessionOrganizationOrderScopeKindSchema>;

export const SessionOrganizationOrderItemKindSchema = lazyZodSchema(() => z.enum(SESSION_ORGANIZATION_ORDER_ITEM_KINDS));
export type SessionOrganizationOrderItemKind = z.infer<typeof SessionOrganizationOrderItemKindSchema>;

export const SessionOrganizationOrderEntrySchema = lazyZodSchema(() => z.strictObject({
    scopeKind: SessionOrganizationOrderScopeKindSchema,
    scopeKey: SessionOrganizationScopeKeySchema,
    itemKind: SessionOrganizationOrderItemKindSchema,
    itemKey: SessionOrganizationItemKeySchema,
    sortKey: SessionOrganizationSortKeySchema,
  }));
export type SessionOrganizationOrderEntry = z.infer<typeof SessionOrganizationOrderEntrySchema>;
export const SessionOrganizationOrderEntryStoredSchema = createStoredReadSchema(SessionOrganizationOrderEntrySchema);

export const SessionOrganizationLabelKindSchema = lazyZodSchema(() => z.enum(SESSION_ORGANIZATION_LABEL_KINDS));
export type SessionOrganizationLabelKind = z.infer<typeof SessionOrganizationLabelKindSchema>;

export const SessionOrganizationLabelSchema = lazyZodSchema(() => z.strictObject({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationScopeKeySchema,
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
    displayState: z.optional(SessionOrganizationDisplayStateSchema),
    archivedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionOrganizationLabel = z.infer<typeof SessionOrganizationLabelSchema>;
export const SessionOrganizationLabelStoredSchema = createStoredReadSchema(SessionOrganizationLabelSchema);
