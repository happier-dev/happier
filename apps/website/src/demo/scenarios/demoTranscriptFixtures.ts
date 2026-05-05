import type { AgentMessage } from '../timeline/types';

export const authSkeletonMessages: readonly AgentMessage[] = [
    {
        id: 'm-auth-task',
        role: 'user',
        text: 'fix the flash of unauthed content on /dashboard',
    },
    {
        id: 'm-auth-plan',
        role: 'agent',
        text: 'I found the auth boundary and I am adding a skeleton while the session resolves.',
    },
];

export const authSkeletonMessagesWithFollowUp: readonly AgentMessage[] = [
    ...authSkeletonMessages,
    {
        id: 'm-follow-up',
        role: 'user',
        text: 'also add a skeleton loader while auth resolves',
    },
];

export const remoteLaunchPromptMessages: readonly AgentMessage[] = [
    {
        id: 'remote-prompt',
        role: 'user',
        text: 'Implement the dashboard auth skeleton and open a PR.',
    },
];

export const remoteLaunchRunningMessages: readonly AgentMessage[] = [
    ...remoteLaunchPromptMessages,
    {
        id: 'remote-opencode-stream',
        role: 'agent',
        text: 'OpenCode is running in the background on MacBook Pro and preparing the dashboard skeleton patch.',
    },
];
