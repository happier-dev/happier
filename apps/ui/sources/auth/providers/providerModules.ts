import type { AuthProvider } from '@/auth/providers/types';
import { githubAuthProvider } from '@/auth/providers/github';

export const authProviderModules: readonly AuthProvider[] = Object.freeze([
    githubAuthProvider,
]);

