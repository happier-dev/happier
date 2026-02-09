import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';

import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import type { AgentId } from '@/agents/registry/registryCore';

export function useEnabledAgentIds(): AgentId[] {
    const backendEnabledById = useSetting('backendEnabledById');

    return React.useMemo(() => {
        return getEnabledAgentIds({ backendEnabledById });
    }, [backendEnabledById]);
}
