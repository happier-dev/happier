import { z } from 'zod';

export const PluginVersionV1Schema = z.literal(1).default(1);

export const PluginLooseJsonObjectSchema = z.record(z.string(), z.unknown());

export const PluginStringArraySchema = z.array(z.string().min(1)).default([]);

export const PluginAssetRefV1Schema = z.string().trim().min(1);

export const PluginOptionalStringSchema = z.string().trim().min(1).optional();
