import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ImageRefSchema = lazySchema(() => z.object({
  path: z.string(),
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbhash: z.string().optional(),
}));

export type ImageRef = z.infer<typeof ImageRefSchema>;

