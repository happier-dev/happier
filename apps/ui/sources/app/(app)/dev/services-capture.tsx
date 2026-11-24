import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
  CaptureSpecimen,
  type CaptureSpecimenState,
} from '@/components/dev/services/CaptureSpecimen';

const STATES: readonly CaptureSpecimenState[] = [
  'unavailable',
  'stale',
  'restart',
  'approval',
];
const VIEWS = ['endpoints', 'traces', 'logs'] as const;

/**
 * Dev-only: Dev servers capture in the states a live bed reaches only by breaking it.
 * `?state=unavailable|stale|restart|approval` (default unavailable), `?view=endpoints|traces|logs` (default endpoints).
 */
export default function ServicesCaptureDevScreen() {
  const params = useLocalSearchParams<{ state?: string; view?: string }>();
  const state =
    STATES.find((candidate) => candidate === params.state) ?? 'unavailable';
  const view =
    VIEWS.find((candidate) => candidate === params.view) ?? 'endpoints';
  return <CaptureSpecimen state={state} view={view} />;
}
