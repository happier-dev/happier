import * as React from 'react';

/**
 * Whether the status row's host actions draw as quiet icons because the row's line carries a blocker
 * and its way forward (an agent that needs sign-in, then Sign in). That sentence is the row's primary
 * message: the host's secondary actions give up their labels before it ever truncates.
 */
export const StatusRowLineLeadsContext = React.createContext(false);

export function useStatusRowLineLeads(): boolean {
    return React.useContext(StatusRowLineLeadsContext);
}
