import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';

/** The open flow owns its read lifetime; retiring its opener does not cancel the panel's Action. */
export function useWidgetDefinitionFlowRead(input: Readonly<{
    account: ServerAccountScope;
    scope: WidgetSurfaceRefV1;
    instance: WidgetInstanceV1;
    isCurrent?: () => boolean;
    callerContext?: ActionExecutorContext;
}>) {
    const artifactId = input.instance.definition.kind === 'artifact' ? input.instance.definition.artifactId : null;
    const { serverId, accountId } = input.account;
    const viewer = useActiveServerAccountScope();
    const current = input.isCurrent?.() !== false && areServerAccountScopesEqual(viewer, input.account)
        && areServerProfileIdentifiersEquivalent(serverId, input.scope.serverId)
        && (!artifactId || accountId === input.scope.accountId);
    const [opened, setOpened] = React.useState<PublicActionResultById['widgets.definition.get'] | 'loading' | 'unavailable'>('loading');
    const callerContext = input.callerContext;
    React.useEffect(() => {
        if (!artifactId || !current) return;
        const controller = new AbortController();
        void runWidgetDefinitionCommand('widgets.definition.get', { account: { serverId, accountId }, artifactId },
            { serverId, accountId }, controller.signal, undefined, { callerContext }).then(outcome => {
            if (!controller.signal.aborted) setOpened(outcome.kind === 'applied' ? outcome.result : 'unavailable');
        });
        return () => controller.abort();
    }, [accountId, artifactId, serverId, current, callerContext]);
    const state = !current ? 'unavailable' : artifactId && typeof opened === 'string' ? opened : 'ready';
    return { current, state,
        definition: artifactId ? typeof opened === 'object' && current ? opened.definition : null
            : input.instance.definition.kind === 'inline' && current ? input.instance.definition.definition : null,
        placements: artifactId ? typeof opened === 'object' && current ? opened.placementSummary ?? null : null
            : { placements: [{ surface: input.scope, instanceId: input.instance.id }], unavailableScopes: [] },
    };
}
