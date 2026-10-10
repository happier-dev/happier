import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ProviderHttpsUrlSchema = lazyZodSchema(() => z.url().refine(
  (value) => new URL(value).protocol === 'https:',
  'Provider user-openable links must use HTTPS',
));
