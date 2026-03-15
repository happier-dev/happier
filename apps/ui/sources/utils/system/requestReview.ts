import * as StoreReview from 'expo-store-review';
import { Platform } from 'react-native';
import { AsyncLock } from './lock';
import {
    trackReviewStoreShown,
} from '@/track';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';

const STORE_REVIEW_PROMPTS_FEATURE_ID = 'app.ui.storeReviewPrompts' as const satisfies FeatureId;
const lock = new AsyncLock();

export async function canRequestReview(): Promise<boolean> {
    if (Platform.OS === 'web') {
        return false;
    }

    if (getFeatureBuildPolicyDecision(STORE_REVIEW_PROMPTS_FEATURE_ID) === 'deny') {
        return false;
    }

    try {
        return await StoreReview.isAvailableAsync();
    } catch {
        return false;
    }
}

export function requestReview() {
    lock.inLock(async () => {
        try {
            const available = await canRequestReview();
            if (!available) return;
            await StoreReview.requestReview();
            trackReviewStoreShown();
        } catch {
            // no-op: never block settings interactions when store review is unavailable
        }
    });
}
