import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const PluginVersionV1Schema = lazyZodSchema(() => z.literal(1).default(1));

export const PluginLooseJsonObjectSchema = lazyZodSchema(() => z.record(z.string(), z.unknown()));

export const PluginStringArraySchema = lazyZodSchema(() => z.array(z.string().min(1)).default([]));

export const PluginAssetRefV1Schema = lazyZodSchema(() => z.string().trim().min(1));

export const PluginOptionalStringSchema = lazyZodSchema(() => z.string().trim().min(1).optional());
