import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { PetStoreSpecimen } from '@/components/dev/pets/PetStoreSpecimen';

/** Dev-only: Store › Pets, a pet listing and its Add outcomes at fixture props (lab R12). `?scene=store|listing|states`. */
export default function PetStoreDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <PetStoreSpecimen scene={typeof params.scene === 'string' ? params.scene : 'store'} />;
}
