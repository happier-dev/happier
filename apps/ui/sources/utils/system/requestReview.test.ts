import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSystemUtilityCommonModuleMocks } from './systemUtilityTestHelpers';

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

const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/track', () => ({
    trackReviewPromptShown: vi.fn(),
    trackReviewPromptResponse: vi.fn(),
    trackReviewStoreShown: vi.fn(),
    trackReviewRetryScheduled: vi.fn(),
}));

const syncApplySettingsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: syncApplySettingsSpy,
    },
}));

installSystemUtilityCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({
                    settings: {
                        reviewPromptAnswered: false,
                        reviewPromptLikedApp: null,
                    },
                }),
            },
        });
    },
});

async function flushMicrotasks(iterations: number = 5): Promise<void> {
    for (let i = 0; i < iterations; i += 1) {
        await Promise.resolve();
    }
}

async function loadRequestReview(params: { platformOs: string }) {
    vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: params.platformOs,
            },
        }
    );
});

    return await import('./requestReview');
}

describe('requestReview', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        storeReview.isAvailableAsync.mockClear();
        storeReview.requestReview.mockClear();
        modalConfirmSpy.mockClear();
        syncApplySettingsSpy.mockClear();
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

    it('requests store review directly without modal pre-prompt or synced review flags', async () => {
        const { requestReview } = await loadRequestReview({ platformOs: 'ios' });

        requestReview();
        await flushMicrotasks();

        expect(storeReview.requestReview).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(syncApplySettingsSpy).not.toHaveBeenCalled();
    });
});
