import * as React from 'react';

import type { AgentId } from '@/agents/registry/registryCore';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { Settings } from '@/sync/domains/settings/settings';

export function useResumeCapabilityOptions(opts: {
    agentId: AgentId;
    machineId: string | null | undefined;
    serverId?: string | null;
    settings: Settings;
    enabled?: boolean;
}): {
    resumeCapabilityOptions: ResumeCapabilityOptions;
} {
    const resumeCapabilityOptions = React.useMemo(() => {
        return buildResumeCapabilityOptionsFromUiState({
            settings: opts.settings,
            results: undefined,
        });
    }, [opts.settings]);

    return { resumeCapabilityOptions };
}
