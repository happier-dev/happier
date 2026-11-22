import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
  APPROVAL_CARD_SCENES,
  ApprovalCardSpecimen,
} from '@/components/dev/approvals/ApprovalCardSpecimen';

/** Dev-only: the composer's approval tray. `?scene=open|facts|failed&room=<px>`. */
export default function ApprovalCardDevScreen() {
  const params = useLocalSearchParams<{ scene?: string; room?: string }>();
  const scene =
    APPROVAL_CARD_SCENES.find((name) => name === params.scene) ?? 'open';
  const room = Number(params.room);
  return (
    <ApprovalCardSpecimen
      scene={scene}
      roomPx={Number.isFinite(room) && room > 0 ? room : 220}
    />
  );
}
