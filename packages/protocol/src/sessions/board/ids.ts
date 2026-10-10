import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { SessionSystemRecordLocalIdSchema } from '../system/records/sessionSystemRecordAddress.js';

// SSR record identity includes namespace/localId, not kind. The layout owns
// host/surface/layout, so an item cannot occupy that exact address.
export const SessionSurfaceItemIdSchema = lazyZodSchema(() => SessionSystemRecordLocalIdSchema.refine(id => id !== 'layout', {
  message: 'This address is reserved for the Board layout',
}));
export const SessionBoardTabIdSchema = SessionSystemRecordLocalIdSchema;
export type SessionSurfaceItemId = z.infer<typeof SessionSurfaceItemIdSchema>;
export type SessionBoardTabId = z.infer<typeof SessionBoardTabIdSchema>;
