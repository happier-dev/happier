import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RailPlacementSpecimen } from '@/components/dev/RailPlacementSpecimen';

export default function RailPlacementDevScreen() {
    const params = useLocalSearchParams<{ frame?: string }>();
    return <RailPlacementSpecimen frame={typeof params.frame === 'string' ? params.frame : null} />;
}
