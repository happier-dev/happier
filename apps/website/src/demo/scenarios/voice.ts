import type { Scenario } from '../timeline/types';
import { createBeat, createInitialBridgeState } from './scenarioFixtures';

const transcript = [
    { id: 'v1', role: 'user' as const, text: "Hey Happier, what's running?" },
    {
        id: 'v2',
        role: 'agent' as const,
        text: 'Refactor finished its split. Tests has one failing useSession test.',
    },
    { id: 'v3', role: 'user' as const, text: 'What failed?' },
    {
        id: 'v4',
        role: 'agent' as const,
        text: 'The hook now preserves stale session data, but the fixture still expects a blank refresh.',
    },
    { id: 'v5', role: 'user' as const, text: 'Have the refactor session take a look.' },
] as const;

export const voiceScenario: Scenario = {
    id: 'voice',
    title: 'Voice',
    durationMs: 26_000,
    totalDuration: 26_000,
    initialBridgeState: {
        ...createInitialBridgeState('voice', 'voice'),
        voice: { phase: 'idle', transcript: [] },
    },
    beats: [
        createBeat({
            id: 'voice-running',
            atMs: 0,
            durationMs: 4_000,
            focus: 'phone',
            visibleSurfaces: ['voice', 'desktop-session'],
            state: {
                sessionTitle: 'Voice',
                sessionMeta: 'listening across sessions',
                activityChip: { device: 'phone', label: 'Hey Happier, what is running?' },
            },
            voice: { phase: 'listening', transcript: transcript.slice(0, 1) },
            bridgePatch: { voice: { phase: 'listening', transcript: transcript.slice(0, 1) } },
        }),
        createBeat({
            id: 'voice-summary',
            atMs: 4_000,
            durationMs: 5_000,
            focus: 'phone',
            visibleSurfaces: ['voice', 'desktop-session'],
            state: {
                sessionTitle: 'Voice',
                sessionMeta: 'cross-session summary',
                activityChip: { device: 'phone', label: 'Summarizing running sessions' },
            },
            voice: { phase: 'summarizing', transcript: transcript.slice(0, 3) },
            bridgePatch: { voice: { phase: 'summarizing', transcript: transcript.slice(0, 3) } },
        }),
        createBeat({
            id: 'voice-route',
            atMs: 9_000,
            durationMs: 5_000,
            focus: 'phone',
            visibleSurfaces: ['voice', 'desktop-session'],
            state: {
                sessionTitle: 'Voice',
                sessionMeta: 'routing instruction',
                activityChip: { device: 'phone', label: 'Routing to refactor session' },
                syncPulseKey: 1,
            },
            voice: { phase: 'routing', transcript },
            bridgePatch: { voice: { phase: 'routing', transcript } },
        }),
        createBeat({
            id: 'voice-approval',
            atMs: 14_000,
            durationMs: 5_500,
            focus: 'all',
            visibleSurfaces: ['voice', 'desktop-session'],
            state: {
                sessionTitle: 'Voice',
                sessionMeta: 'approval-gated edit',
                permission: {
                    id: 'voice-edit-test',
                    agent: 'Claude',
                    verb: 'edit',
                    target: 'useSession.test.ts',
                    state: 'pending',
                },
                activityChip: { device: 'phone', label: 'Claude wants to edit useSession.test.ts' },
                syncPulseKey: 2,
            },
            voice: { phase: 'approval', transcript },
            bridgePatch: {
                voice: { phase: 'approval', transcript },
                permissionsBySession: {
                    's-auth-skeleton': {
                        id: 'voice-edit-test',
                        agent: 'Claude',
                        verb: 'edit',
                        target: 'useSession.test.ts',
                        state: 'pending',
                    },
                },
            },
        }),
        createBeat({
            id: 'voice-approved',
            atMs: 19_500,
            durationMs: 6_500,
            focus: 'phone',
            visibleSurfaces: ['voice', 'desktop-session'],
            state: {
                sessionTitle: 'Voice',
                sessionMeta: "Approved. I'll ping you when it's green.",
                activityChip: { device: 'phone', label: 'Approved by voice' },
                syncPulseKey: 3,
            },
            voice: {
                phase: 'approved',
                transcript: [
                    ...transcript,
                    { id: 'v6', role: 'user', text: 'Approve.' },
                    {
                        id: 'v7',
                        role: 'agent',
                        text: "Approved. I'll ping you when it's green.",
                    },
                ],
            },
            bridgePatch: {
                voice: {
                    phase: 'approved',
                    transcript: [
                        ...transcript,
                        { id: 'v6', role: 'user', text: 'Approve.' },
                        {
                            id: 'v7',
                            role: 'agent',
                            text: "Approved. I'll ping you when it's green.",
                        },
                    ],
                },
                permissionsBySession: {
                    's-auth-skeleton': {
                        id: 'voice-edit-test',
                        agent: 'Claude',
                        verb: 'edit',
                        target: 'useSession.test.ts',
                        state: 'approved',
                    },
                },
            },
        }),
    ],
};
