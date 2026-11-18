import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ReviewDetailSpecimen } from '@/components/dev/reviews/ReviewDetailSpecimen';

/** Dev-only: the Review page. `?scene=findings|submit|newround|round2|nomachine|runs|loading|failed`. */
export default function ReviewDetailDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <ReviewDetailSpecimen scene={typeof params.scene === 'string' ? params.scene : null} />;
}
