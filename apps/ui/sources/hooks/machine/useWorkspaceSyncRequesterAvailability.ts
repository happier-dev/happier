import * as React from 'react';
import type { WorkspaceSyncRequesterAvailabilityV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineField } from '@/sync/store/hooks';
import { readWorkspaceSyncRequesterAvailability } from '@/sync/ops/workspaceSync';

/** Demand one read per mounted endpoint and Account/policy, never resource publications. */
export function useWorkspaceSyncRequesterAvailability(input: Readonly<{
    serverId: string;
    machineId: string | null | undefined;
}>) {
    const { binding } = useServerCredentialAccountScopeBinding(input.serverId);
    const policy = useMachineField(input.machineId ?? '', 'metadata', 'agentIsolation', {
        serverId: input.serverId, enabled: Boolean(input.machineId),
    });
    const key = JSON.stringify([binding?.scope, binding?.revision, input.machineId, policy]);
    const [state, setState] = React.useState<Readonly<{ key: string; availability: WorkspaceSyncRequesterAvailabilityV1 | null }>>({ key, availability: null });
    React.useEffect(() => {
        if (!binding || !input.machineId) return;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        const current = () => !controller.signal.aborted && binding.isCurrent();
        void readWorkspaceSyncRequesterAvailability({ controllerMachineId: input.machineId,
            serverId: binding.serverId, accountId: binding.accountId, signal: controller.signal }).then(availability => {
            if (current()) setState({ key, availability });
        }, () => { if (current()) setState({ key, availability: null }); });
        return () => { retirement.dispose(); controller.abort(); };
    }, [binding, input.machineId, key]);
    return binding?.isCurrent() && state.key === key ? state.availability : null;
}
