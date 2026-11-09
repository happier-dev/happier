import * as React from 'react';
import type {
    CurrentSessionPresentationIntentResultV1,
    CurrentSessionPresentationIntentV1,
} from '@happier-dev/protocol/sessions';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type SessionWorkPresentationIntent = Extract<CurrentSessionPresentationIntentV1, {
    kind: 'work.view.select' | 'work.recent.show_more' | 'work.map.expand';
}>;

export type SessionWorkPresentationBinding = Readonly<{
    address: SessionAddress;
    apply: (intent: SessionWorkPresentationIntent) => CurrentSessionPresentationIntentResultV1;
}>;

/** The existing Session Work owner carries only its currently presented view's local port. */
export const SessionWorkPresentationContext = React.createContext<
    React.MutableRefObject<SessionWorkPresentationBinding | null> | null
>(null);
