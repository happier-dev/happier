import * as React from 'react';
import { View } from 'react-native';

import { VoiceOrb } from '@/components/voice/orb/VoiceOrb';

import type { VoiceConceptProps } from '../conceptTypes';
import { createProductionVoiceConceptFixture } from './productionVoiceConceptAdapter';

/** The selected Orb lab direction is now a fixture adapter over production. */
export function OrbConcept(props: VoiceConceptProps): React.ReactElement {
    const fixture = createProductionVoiceConceptFixture(props);
    const [availableHeight, setAvailableHeight] = React.useState(520);
    return (
        <View
            style={{ width: '100%', height: '100%' }}
            onLayout={(event) => {
                const next = Math.max(1, Math.round(event.nativeEvent.layout.height));
                setAvailableHeight((current) => current === next ? current : next);
            }}
        >
            <VoiceOrb
                control={fixture.control}
                labels={fixture.orbLabels}
                expanded={props.expanded}
                onExpandedChange={(next) => {
                    if (next !== props.expanded) props.onToggleExpanded();
                }}
                restingBottomInset={34}
                availableSheetHeight={availableHeight}
                extraControls={fixture.extraControls}
                onAction={props.onAction}
                testID="voice-lab-production-orb"
            />
        </View>
    );
}
