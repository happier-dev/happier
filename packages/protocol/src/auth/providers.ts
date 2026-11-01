import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const AuthProviderIdSchema = lazySchema(() => z.string().min(1));
export type AuthProviderId = z.infer<typeof AuthProviderIdSchema>;
