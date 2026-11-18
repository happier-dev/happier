import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ReviewFindingSpecimen } from '@/components/dev/reviews/ReviewFindingSpecimen';

/** Dev-only: the opened finding (Reviews lab merged B). `?width=narrow` for the split column, `?open=<id>`. */
export default function ReviewFindingDevScreen() {
    const params = useLocalSearchParams<{ width?: string; open?: string }>();
    return (
        <ReviewFindingSpecimen
            width={typeof params.width === 'string' ? params.width : null}
            open={typeof params.open === 'string' ? params.open : null}
        />
    );
}
