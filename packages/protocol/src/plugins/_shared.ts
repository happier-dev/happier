import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const PluginVersionV1Schema = lazyZodSchema(() => z._default(z.literal(1), 1));

export const PluginLooseJsonObjectSchema = lazyZodSchema(() => z.record(z.string(), z.unknown()));

export const PluginStringArraySchema = lazyZodSchema(() => z._default(z.array(z.string().check(z.minLength(1))), []));

export const PluginAssetRefV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const PluginOptionalStringSchema = lazyZodSchema(() => z.optional(z.string().check(z.trim(), z.minLength(1))));

/** HostAccess references name manifest request ids, not contribution local ids. */
export const PluginHostAccessRequestIdV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
