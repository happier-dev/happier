import type { AgentId } from '@/agents/catalog/catalog';

import type {
    ExistingSessionAutomationAuthoringContext,
    LiveSessionAuthoringContext,
} from './sessionAuthoringContext';
import { resolveSessionComposerState, type SessionComposerState } from './resolveSessionComposerState';

export type SessionComposerAuthoringContext =
    | ExistingSessionAutomationAuthoringContext
    | LiveSessionAuthoringContext;

export function resolveSessionComposerStateFromAuthoringContext(
    context: SessionComposerAuthoringContext,
    params?: Readonly<{
        fallbackAgentId?: AgentId | null;
    }>,
): SessionComposerState {
    if (context.kind === 'automationExistingSession') {
        return resolveSessionComposerState({
            snapshot: context.snapshot,
            session: context.session,
            permissionModeOverride: context.draft.permissionMode as SessionComposerState['permissionMode'] | null,
            modelModeOverride: context.draft.modelId as SessionComposerState['modelMode'] | null,
            profileIdOverride: context.draft.profileId ?? null,
            currentPathOverride: context.draft.directory,
        });
    }

    return resolveSessionComposerState({
        snapshot: context.snapshot,
        session: context.session,
        fallbackAgentId: params?.fallbackAgentId ?? null,
    });
}
