import { z } from 'zod';

export const ProviderHttpsUrlSchema = z.url().refine(
  (value) => new URL(value).protocol === 'https:',
  'Provider user-openable links must use HTTPS',
);
