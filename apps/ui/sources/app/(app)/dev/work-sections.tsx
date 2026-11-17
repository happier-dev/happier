import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { WorkSectionsSpecimen } from '@/components/dev/workSections/WorkSectionsSpecimen';
import { WorkStatesSpecimen } from '@/components/dev/workSections/WorkStatesSpecimen';

/**
 * Dev-only: the Work tab's configuration sections (lab `convo-W9` / `P9`) through the real section frame;
 * `?scene=states` draws a coordinator's Work rows, Map and digest Recap states (lab V3 P1-C) from real owners.
 */
export default function WorkSectionsDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return params.scene === 'states' ? <WorkStatesSpecimen /> : <WorkSectionsSpecimen />;
}
