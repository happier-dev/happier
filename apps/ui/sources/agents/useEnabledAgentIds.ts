import * as React from 'react';

import { useSetting } from '@/sync/storage';

import { getEnabledAgentIds } from './enabled';
import type { AgentId } from './registryCore';

export function useEnabledAgentIds(): AgentId[] {
    const backendEnabledById = useSetting('backendEnabledById');

    return React.useMemo(() => {
        return getEnabledAgentIds({ backendEnabledById });
    }, [backendEnabledById]);
}
