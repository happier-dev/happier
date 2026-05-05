import type { Scenario } from '../timeline/types';
import { createBeat, createInitialBridgeState } from './scenarioFixtures';

const sessions = [
    {
        id: 's-parallel-claude',
        title: 'Refactor shell',
        provider: 'Claude' as const,
        status: 'running' as const,
        machineId: 'm-macbook-pro',
        path: '/Users/demo/code/happier',
        startedBy: 'terminal' as const,
    },
    {
        id: 's-parallel-codex',
        title: 'Stabilize tests',
        provider: 'Codex' as const,
        status: 'running' as const,
        machineId: 'm-macbook-pro',
        path: '/Users/demo/code/happier',
        startedBy: 'terminal' as const,
    },
    {
        id: 's-parallel-opencode',
        title: 'Docs build',
        provider: 'OpenCode' as const,
        status: 'waiting' as const,
        machineId: 'm-macbook-pro',
        path: '/Users/demo/code/happier',
        startedBy: 'daemon' as const,
    },
] as const;

export const parallelScenario: Scenario = {
    id: 'parallel',
    title: 'Parallel',
    durationMs: 24_000,
    totalDuration: 24_000,
    initialBridgeState: {
        ...createInitialBridgeState('parallel', 'desktop-session'),
        sessions,
        activeSessionId: 's-parallel-claude',
    },
    beats: [
        createBeat({
            id: 'parallel-inbox',
            atMs: 0,
            durationMs: 4_000,
            focus: 'all',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            terminal: {
                commands: ['happier claude', 'happier codex', 'happier opencode'],
                lines: [
                    { kind: 'user', text: '$ happier claude --worktree refactor' },
                    { kind: 'user', text: '$ happier codex --worktree tests' },
                    { kind: 'user', text: '$ happier opencode --worktree docs' },
                ],
            },
            state: {
                sessionTitle: 'One inbox',
                sessionMeta: 'three independent agents',
                activityChip: { device: 'desktop', label: '3 agents in one inbox' },
            },
            bridgePatch: { sessions },
        }),
        createBeat({
            id: 'round-robin-permissions',
            atMs: 4_000,
            durationMs: 6_000,
            focus: 'phone',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            state: {
                sessionTitle: 'One inbox',
                sessionMeta: 'pending permissions',
                activityChip: { device: 'phone', label: 'Approving round-robin' },
                syncPulseKey: 1,
            },
            bridgePatch: {
                permissionsBySession: {
                    's-parallel-claude': {
                        id: 'p-refactor',
                        agent: 'Claude',
                        verb: 'edit',
                        target: 'SessionShell.tsx',
                        state: 'pending',
                    },
                    's-parallel-codex': {
                        id: 'p-tests',
                        agent: 'Codex',
                        verb: 'run',
                        target: 'website tests',
                        state: 'pending',
                    },
                    's-parallel-opencode': {
                        id: 'p-docs',
                        agent: 'OpenCode',
                        verb: 'write',
                        target: 'docs/website-demo.md',
                        state: 'pending',
                    },
                },
            },
        }),
        createBeat({
            id: 'claude-done',
            atMs: 10_000,
            durationMs: 4_000,
            focus: 'desktop',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            state: {
                sessionTitle: 'One inbox',
                sessionMeta: 'Claude finished, Codex still running',
                activityChip: { device: 'desktop', label: 'Claude done, Codex running' },
                syncPulseKey: 2,
            },
        }),
        createBeat({
            id: 'opencode-waiting',
            atMs: 14_000,
            durationMs: 5_000,
            focus: 'phone',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            state: {
                sessionTitle: 'One inbox',
                sessionMeta: 'OpenCode docs task waiting',
                activityChip: { device: 'phone', label: 'OpenCode permission waiting' },
                syncPulseKey: 3,
            },
        }),
        createBeat({
            id: 'parallel-clear',
            atMs: 19_000,
            durationMs: 5_000,
            focus: 'all',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            state: {
                sessionTitle: 'One inbox',
                sessionMeta: 'all independent sessions controlled',
                activityChip: { device: 'desktop', label: 'All permissions cleared' },
                syncPulseKey: 4,
            },
            bridgePatch: { permissionsBySession: {} },
        }),
    ],
};
