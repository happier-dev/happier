import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ThemeLibrarySpecimen } from '@/components/dev/themes/ThemeLibrarySpecimen';

/** Dev-only: Appearance → Themes and the theme editor at fixture props. `?scene=A1|E1|E3|E4|D1|D2|D3|D4`. */
export default function ThemeLibraryDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <ThemeLibrarySpecimen scene={params.scene ?? 'A1'} />;
}
