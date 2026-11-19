import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ReviewStartSpecimen } from '@/components/dev/reviews/ReviewStartSpecimen';

/** Dev-only: the Reviews start sheet's steps and options (Reviews lab start-sheet). `?scene=rounds|deep`. */
export default function ReviewStartDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <ReviewStartSpecimen scene={typeof params.scene === 'string' ? params.scene : null} />;
}
