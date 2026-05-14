import { useWindowDimensions } from 'react-native';

import { resolveViewportClass } from '@/utils/platform/viewportClass';

export function useActionSettingsNarrowLayout(): boolean {
    const { width, height } = useWindowDimensions();
    return resolveViewportClass({ width, height }) === 'compact';
}
