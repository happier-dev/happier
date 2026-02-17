import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeReview = vi.hoisted(() => ({
    isAvailableAsync: vi.fn(async () => true),
    requestReview: vi.fn(async () => {}),
}));

vi.mock('expo-store-review', () => storeReview);

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/modal', () => ({
    Modal: {
        confirm: vi.fn(async () => true),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/track', () => ({
    trackReviewPromptShown: vi.fn(),
    trackReviewPromptResponse: vi.fn(),
    trackReviewStoreShown: vi.fn(),
    trackReviewRetryScheduled: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            settings: {
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
            },
        }),
    },
}));

async function flushMicrotasks(iterations: number = 5): Promise<void> {
    for (let i = 0; i < iterations; i += 1) {
        await Promise.resolve();
    }
}

async function loadRequestReview(params: { platformOs: string }) {
    vi.doMock('react-native', async () => {
        const actual = await vi.importActual<any>('react-native');
        return {
            ...actual,
            Platform: { ...(actual?.Platform ?? {}), OS: params.platformOs },
        };
    });

    return await import('./requestReview');
}

describe('requestReview', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        storeReview.isAvailableAsync.mockClear();
        storeReview.requestReview.mockClear();
        kvStore.clear();
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    });

    afterEach(() => {
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('does not attempt store review when build policy denies store review prompts', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.storeReviewPrompts';

        const { requestReview } = await loadRequestReview({ platformOs: 'ios' });

        requestReview();
        await flushMicrotasks();

        expect(storeReview.isAvailableAsync).not.toHaveBeenCalled();
        expect(storeReview.requestReview).not.toHaveBeenCalled();
    });
});

