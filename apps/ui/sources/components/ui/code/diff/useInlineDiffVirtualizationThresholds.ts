import { useSetting } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';

export type InlineDiffVirtualizationThresholds = Readonly<{
    lineThreshold: number;
    byteThreshold: number;
}>;

export function useInlineDiffVirtualizationThresholds(): InlineDiffVirtualizationThresholds {
    const lineThresholdSetting = useSetting('filesDiffInlineVirtualizationLineThreshold');
    const byteThresholdSetting = useSetting('filesDiffInlineVirtualizationByteThreshold');

    const lineThreshold = typeof lineThresholdSetting === 'number'
        ? lineThresholdSetting
        : (settingsDefaults.filesDiffInlineVirtualizationLineThreshold as number);
    const byteThreshold = typeof byteThresholdSetting === 'number'
        ? byteThresholdSetting
        : (settingsDefaults.filesDiffInlineVirtualizationByteThreshold as number);

    return { lineThreshold, byteThreshold };
}
