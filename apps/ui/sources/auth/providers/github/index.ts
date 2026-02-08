import { createExternalOAuthProvider } from '@/auth/providers/externalOAuthProvider';

export const githubAuthProvider = createExternalOAuthProvider({
    id: 'github',
    displayName: 'GitHub',
    badgeIconName: 'logo-github',
    supportsProfileBadge: true,
    connectButtonColor: '#24292e',
});
