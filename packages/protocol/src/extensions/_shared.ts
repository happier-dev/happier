import { z } from 'zod';

export const ExtensionVersionV1Schema = z.literal(1).default(1);

export const LooseJsonObjectSchema = z.record(z.string(), z.unknown());

export const StringArraySchema = z.array(z.string().min(1)).default([]);

export const AssetRefV1Schema = z.string().trim().min(1);

export const OptionalStringSchema = z.string().trim().min(1).optional();
