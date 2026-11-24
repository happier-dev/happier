import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
  PENDING_MESSAGES_SCENES,
  PendingMessagesSpecimen,
} from '@/components/dev/pending/PendingMessagesSpecimen';

/** Dev-only: a stopped Session's queued messages. `?scene=queued|held` (held: Machine access withdrawn). */
export default function PendingMessagesDevScreen() {
  const params = useLocalSearchParams<{ scene?: string }>();
  const scene =
    PENDING_MESSAGES_SCENES.find((name) => name === params.scene) ?? 'queued';
  return <PendingMessagesSpecimen scene={scene} />;
}
