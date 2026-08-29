import * as React from 'react';

import { VoiceHorizon } from '@/components/voice/surface/presentations/VoiceHorizon';

import type { VoiceConceptProps } from '../conceptTypes';
import { createProductionVoiceConceptFixture } from './productionVoiceConceptAdapter';

/** The selected Horizon lab direction is now a fixture adapter over production. */
export function HorizonConcept(props: VoiceConceptProps): React.ReactElement {
    const fixture = createProductionVoiceConceptFixture(props);
    return <VoiceHorizon model={fixture.horizonModel} />;
}
