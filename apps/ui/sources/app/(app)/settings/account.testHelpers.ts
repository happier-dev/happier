import { createWelcomeFeaturesResponse } from '../index.testHelpers';

type AccountFeaturesOverrides = {
    friendsEnabled?: boolean;
    friendsAllowUsername?: boolean;
};

export function createAccountFeaturesResponse(
    overrides: AccountFeaturesOverrides = {},
): ReturnType<typeof createWelcomeFeaturesResponse> {
    const base = createWelcomeFeaturesResponse({
        signupMethods: [{ id: 'anonymous', enabled: true }],
        requiredProviders: [],
        autoRedirectEnabled: false,
        autoRedirectProviderId: null,
        providerOffboardingIntervalSeconds: 600,
    });

    return {
        ...base,
        features: {
            ...base.features,
            social: {
                friends: {
                    enabled: overrides.friendsEnabled ?? true,
                },
            },
        },
        capabilities: {
            ...base.capabilities,
            social: {
                ...base.capabilities.social,
                friends: {
                    ...base.capabilities.social.friends,
                    allowUsername: overrides.friendsAllowUsername ?? true,
                    requiredIdentityProviderId: null,
                },
            },
        },
    };
}

export function isFeaturesRequest(url: string): boolean {
    return url.endsWith('/v1/features');
}

export function isUsernameRequest(url: string): boolean {
    return url.endsWith('/v1/account/username');
}

export function getRequestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
    if (typeof input === 'object' && input && 'url' in input && typeof input.url === 'string') {
        return input.url;
    }
    return String(input);
}
