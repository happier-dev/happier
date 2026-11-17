import type { SupportedLanguage } from '../_all';

type PermissionCopy = Readonly<{ no_tools: string; read_only: string; workspace_write: string; full: string }>;

export type LlmTaskRunnerCopy = Readonly<{
    auto: string;
    autoCurrently: (params: { runner: string }) => string;
    autoNothingReady: string;
    autoDescription: string;
    checking: string;
    currently: (params: { runner: string }) => string;
    noReadyAgent: string;
    noMatchingModel: string;
    unavailable: string;
    chooseMachine: string;
    permissionTitle: string;
    permission: PermissionCopy;
    permissionDescription: PermissionCopy;
}>;

/** The one picker for what a background task (memory hints, commit message, summaries) runs on. */
export const llmTaskRunnerTranslations = {
    en: {
        auto: 'Auto',
        autoCurrently: ({ runner }: { runner: string }) => `Auto — currently ${runner}`,
        autoNothingReady: 'Auto — nothing ready',
        autoDescription: 'Auto uses the cheapest suitable model among the agents that are ready on this machine, at its lowest effort. On a tie it prefers the session’s own agent.',
        checking: 'Checking what’s ready on this machine…',
        currently: ({ runner }: { runner: string }) => `Right now: ${runner}`,
        noReadyAgent: 'No agent on this machine is ready. Sign in to an agent, or choose one here.',
        noMatchingModel: 'The ready agents on this machine offer no model this task can use. Choose one here.',
        unavailable: 'Can’t check this machine right now.',
        chooseMachine: 'Choose a machine to see what Auto picks.',
        permissionTitle: 'Permission level',
        permission: { no_tools: 'No tools', read_only: 'Read-only', workspace_write: 'Can edit files', full: 'Full access' },
        permissionDescription: { no_tools: 'Works only from the text it is given.', read_only: 'Can also use tools that change nothing.', workspace_write: 'Can change files in the project.', full: 'Can use every tool the agent has.' },
    },
} as const satisfies Pick<Record<SupportedLanguage, LlmTaskRunnerCopy>, 'en'>;
