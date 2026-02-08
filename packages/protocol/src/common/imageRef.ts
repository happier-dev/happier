import { z } from 'zod';

export const ImageRefSchema = z.object({
  path: z.string(),
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbhash: z.string().optional(),
});

export type ImageRef = z.infer<typeof ImageRefSchema>;

