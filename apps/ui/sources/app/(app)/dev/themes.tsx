import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ThemesSpecimen } from '@/components/dev/themes/ThemesSpecimen';

/** Dev-only: the agent theme card, device picker and Store → Themes at fixture props. `?scene=B1|B3|B4|E2|E4|failed|C1|C2|C2b|loading|empty|failed-source`. */
export default function ThemesDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <ThemesSpecimen scene={params.scene ?? 'all'} />;
}
