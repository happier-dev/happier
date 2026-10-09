import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * What the user asks an agent to do from Agents settings. The prompts live here, once: the
 * collection's "+" menu and the ACP backend editor both open these.
 */
export type AgentAuthoringIntent =
    /** Configure one custom ACP agent through the `agents.acp.backends.*` actions. */
    | 'configureAcpBackend'
    /** Add a new agent, choosing between an ACP backend and a plugin. */
    | 'addAgent';

const PROMPT_KEY = {
    configureAcpBackend: 'settingsAgents.authoring.configureAcpBackendPrompt',
    addAgent: 'settingsAgents.authoring.addAgentPrompt',
} as const satisfies Record<AgentAuthoringIntent, string>;

/**
 * The New Session seed for an authoring intent. It names the machine Agents manages when there
 * is one and never a folder, so New Session's own last-used machine and folder fill the rest and
 * the user can change both before sending.
 */
export function buildAgentAuthoringSessionSeed(input: Readonly<{
    intent: AgentAuthoringIntent;
    target: Readonly<{ serverId: string; machineId: string }> | null;
}>) {
    return {
        prompt: t(PROMPT_KEY[input.intent]),
        ...(input.target
            ? { placement: { kind: 'exactTarget' as const, serverId: input.target.serverId, machineId: input.target.machineId } }
            : {}),
    };
}

/** Opens the ordinary New Session composer seeded with an agent-authoring prompt. */
export function useOpenAgentAuthoringSession(target: Readonly<{ serverId: string; machineId: string }> | null) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const currentRef = React.useRef({ scope, target });
    currentRef.current = { scope, target };
    return React.useCallback((intent: AgentAuthoringIntent) => {
        if (!scope) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        seedAndOpenNewSession({
            seed: buildAgentAuthoringSessionSeed({ intent, target }),
            scope,
            isCurrent: () => lifetime.isCurrent()
                && areServerAccountScopesEqual(currentRef.current.scope, scope)
                && currentRef.current.target?.serverId === target?.serverId
                && currentRef.current.target?.machineId === target?.machineId,
            navigateToNewSession: ({ draftId, machineId, directory, spawnServerId, worktree }) => {
                const result = runGuardedNavigation(() => router.push({
                    pathname: '/new',
                    params: buildNewSessionLaunchRouteParams({ draftId, machineId, directory, targetServerId: spawnServerId, worktree }),
                } as never));
                if (result !== true) fireAndForget(result, { tag: 'useOpenAgentAuthoringSession' });
            },
        });
    }, [router, scope, target]);
}
