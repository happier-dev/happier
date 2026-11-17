import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { PrimitiveStatesSpecimen } from '@/components/dev/primitiveStates/PrimitiveStatesSpecimen';

/** Dev-only: states moved onto the shared state owners. `?only=<frame title>` renders one frame. */
export default function PrimitiveStatesDevScreen() {
    const params = useLocalSearchParams<{ only?: string }>();
    return <PrimitiveStatesSpecimen only={typeof params.only === 'string' ? params.only : null} />;
}
