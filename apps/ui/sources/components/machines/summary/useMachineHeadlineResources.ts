import * as React from 'react';

import { useServerScopedMachine } from '@/sync/store/hooks';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { readMachinePublishedResources } from './machineResourceSentences';

type HeadlineResources = Pick<NonNullable<ReturnType<typeof readMachinePublishedResources>>, 'attention' | 'host'>;

export function useMachineHeadlineResources(serverId: string, machine: Machine | null): HeadlineResources | null {
    const select = React.useMemo(() => {
        let previous: Machine['daemonState'];
        let value: HeadlineResources | null = null;
        return (current: Machine | null) => {
            const state = (current ?? machine)?.daemonState;
            if (state === previous) return value;
            previous = state;
            const parsed = readMachinePublishedResources(state);
            value = parsed ? retainDeep(value ?? undefined, { host: parsed.host, attention: parsed.attention }) : null;
            return value;
        };
    }, [machine]);
    return useServerScopedMachine(serverId, machine?.id, select);
}
