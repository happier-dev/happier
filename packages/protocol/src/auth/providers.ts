import { z } from 'zod';

export const AuthProviderIdSchema = z.string().min(1);
export type AuthProviderId = z.infer<typeof AuthProviderIdSchema>;
