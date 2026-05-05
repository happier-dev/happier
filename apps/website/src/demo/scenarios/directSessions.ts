import type { Scenario } from '../timeline/types';
import { createBeat, createInitialBridgeState } from './scenarioFixtures';

export const directSessionsScenario: Scenario = {
    id: 'directSessions',
    title: 'Direct sessions',
    durationMs: 26_000,
    totalDuration: 26_000,
    initialBridgeState: {
        ...createInitialBridgeState('directSessions', 'direct-browse'),
        activeSessionId: null,
        sessions: [
            {
                id: 'external-codex-auth',
                title: 'auth-flow',
                provider: 'Codex',
                status: 'running',
                machineId: 'm-macbook-pro',
                path: '/Users/demo/code/auth-flow',
                startedBy: 'external',
            },
        ],
        messagesBySession: {
            'external-codex-auth': [
                {
                    id: 'm-direct-start',
                    role: 'agent',
                    text: 'Codex is already running in this terminal.',
                },
                {
                    id: 'm-direct-link',
                    role: 'agent',
                    text: 'Happier found the session and preserved the live history.',
                },
            ],
        },
        directBrowse: { phase: 'idle' },
    },
    beats: [
        createBeat({
            id: 'external-terminal',
            atMs: 0,
            durationMs: 6_000,
            focus: 'terminal',
            visibleSurfaces: ['terminal', 'direct-browse', 'phone-session'],
            terminal: {
                commands: ['codex'],
                cast: {
                    src: '/casts/codex-atlas.cast',
                    // 148s recording; speed=2 + clip to first 12s shows the
                    // prompt going in plus codex's reasoning + file-listing
                    // response within this 6s beat.
                    speed: 2,
                    endAtSeconds: 12,
                },
                // Fallback lines render only if the cast fails to load. Kept
                // around for test assertions and as graceful-degradation copy.
                lines: [
                    { kind: 'user', text: '$ codex' },
                    { kind: 'agent', text: 'Codex started outside Happier' },
                    { kind: 'info', text: 'Started without Happier', accent: 'orange' },
                ],
            },
            state: {
                sessionTitle: 'External Codex',
                sessionMeta: 'started without Happier',
                activityChip: { device: 'terminal', label: 'Started without Happier' },
            },
        }),
        createBeat({
            id: 'browse-provider-sessions',
            atMs: 6_000,
            durationMs: 4_500,
            focus: 'desktop',
            visibleSurfaces: ['terminal', 'direct-browse', 'phone-session'],
            terminal: {
                cast: { src: '/casts/codex-atlas.cast', speed: 2, endAtSeconds: 30 },
                commands: ['codex'],
                lines: [{ kind: 'info', text: 'External Codex session still running', accent: 'dim' }],
            },
            state: {
                sessionTitle: 'Browse provider sessions',
                sessionMeta: 'machine / provider / source filters',
                activityChip: { device: 'desktop', label: 'Browse provider sessions' },
            },
            bridgePatch: {
                activeView: 'direct-browse',
                directBrowse: { phase: 'scanning' },
            },
        }),
        createBeat({
            id: 'candidate-found',
            atMs: 10_500,
            durationMs: 4_000,
            focus: 'desktop',
            visibleSurfaces: ['terminal', 'direct-browse', 'phone-session'],
            terminal: {
                cast: { src: '/casts/codex-atlas.cast', speed: 2, endAtSeconds: 30 },
                lines: [],
            },
            state: {
                sessionTitle: 'auth-flow',
                sessionMeta: 'Codex / local history / running',
                activityChip: { device: 'desktop', label: 'Codex session found' },
                syncPulseKey: 1,
            },
            bridgePatch: {
                directBrowse: {
                    phase: 'candidates',
                    selectedSessionId: 'external-codex-auth',
                },
            },
        }),
        createBeat({
            id: 'link-session',
            atMs: 14_500,
            durationMs: 4_000,
            focus: 'desktop',
            visibleSurfaces: ['terminal', 'direct-browse', 'phone-session'],
            terminal: {
                cast: { src: '/casts/codex-atlas.cast', speed: 2, endAtSeconds: 30 },
                lines: [],
            },
            state: {
                sessionTitle: 'auth-flow',
                sessionMeta: 'linking into Happier',
                activityChip: { device: 'desktop', label: 'Taking control' },
                syncPulseKey: 2,
            },
            bridgePatch: {
                activeSessionId: 'external-codex-auth',
                directBrowse: {
                    phase: 'linking',
                    selectedSessionId: 'external-codex-auth',
                },
            },
            events: [{ id: 'direct-link', type: 'session' }],
        }),
        createBeat({
            id: 'phone-control',
            atMs: 18_500,
            durationMs: 4_500,
            focus: 'phone',
            visibleSurfaces: ['terminal', 'phone-session', 'direct-browse'],
            terminal: {
                cast: { src: '/casts/codex-atlas.cast', speed: 2, endAtSeconds: 30 },
                lines: [],
            },
            state: {
                sessionTitle: 'auth-flow',
                sessionMeta: 'same external session now controlled from phone',
                activityChip: { device: 'phone', label: 'Control from phone' },
                syncPulseKey: 3,
            },
            bridgePatch: {
                activeView: 'phone-session',
                directBrowse: {
                    phase: 'linked',
                    selectedSessionId: 'external-codex-auth',
                },
            },
        }),
        createBeat({
            id: 'direct-synced',
            atMs: 23_000,
            durationMs: 3_000,
            focus: 'all',
            visibleSurfaces: ['terminal', 'phone-session', 'direct-browse'],
            terminal: {
                cast: { src: '/casts/codex-atlas.cast', speed: 2, endAtSeconds: 30 },
                lines: [],
            },
            state: {
                sessionTitle: 'auth-flow',
                sessionMeta: 'history, permissions, and streaming intact',
                activityChip: { device: 'phone', label: 'External session synced' },
                syncPulseKey: 4,
            },
        }),
    ],
};
