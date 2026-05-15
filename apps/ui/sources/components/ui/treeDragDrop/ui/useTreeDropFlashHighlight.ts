import { useCallback } from 'react';
import { useSharedValue, withTiming } from 'react-native-reanimated';

import { motionTokens } from '@/components/ui/motion/motionTokens';

export function useTreeDropFlashHighlight(): Readonly<{
    progress: ReturnType<typeof useSharedValue<number>>;
    trigger: () => void;
}> {
    const progress = useSharedValue(0);

    const trigger = useCallback(() => {
        progress.value = withTiming(1, { duration: 60 }, () => {
            progress.value = withTiming(0, { duration: motionTokens.durationMs.base });
        });
    }, [progress]);

    return { progress, trigger };
}
