import * as React from 'react';

/**
 * Whether the mounted Session's composer may take custody of its draft. The loaded Session view
 * provides it from `useSessionDraftHydrationAdmission`; a host without a provider (embeds, sheets
 * that own their own admission) is admitted.
 */
export const SessionDraftAdmissionContext = React.createContext(true);
