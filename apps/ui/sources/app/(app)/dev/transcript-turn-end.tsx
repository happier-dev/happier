import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { TranscriptTurnEndSpecimen } from '@/components/dev/transcriptTurnEnd/TranscriptTurnEndSpecimen';

/** Dev-only: the real chat transcript with the "New" divider and turn-end duration lines over a local history. */
export default function TranscriptTurnEndDevScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ stopped?: string }>();
  return <TranscriptTurnEndSpecimen stopped={params.stopped === '1'} />;
}
