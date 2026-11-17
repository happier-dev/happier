import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { PetFaceSpecimen } from '@/components/dev/botFaces/PetFaceSpecimen';

/** Dev-only: a pet as a Bot's face (lab R11). `?only=sizes|states|picker|fallback` renders one section. */
export default function PetFacesDevScreen() {
    const params = useLocalSearchParams<{ only?: string }>();
    return <PetFaceSpecimen only={typeof params.only === 'string' ? params.only : null} />;
}
