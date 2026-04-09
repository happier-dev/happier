import { t } from '@/text';

export function describeBackgroundServiceTargetMode(targetMode: string | null | undefined): string {
    if (targetMode === 'default-following') {
        return t('machine.backgroundServiceModes.defaultFollowing');
    }
    if (targetMode === 'pinned') {
        return t('machine.backgroundServiceModes.legacyPinned');
    }
    return t('machine.backgroundServiceModes.generic');
}
