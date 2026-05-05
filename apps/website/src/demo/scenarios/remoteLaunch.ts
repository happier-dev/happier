import type { Scenario } from '../timeline/types';
import type { DemoBridgeState } from '../timeline/scenarioTypes';
import { createBeat, createInitialBridgeState } from './scenarioFixtures';
import {
    remoteLaunchPromptMessages,
    remoteLaunchRunningMessages,
} from './demoTranscriptFixtures';

const initialBridgeState: DemoBridgeState = {
    ...createInitialBridgeState('remoteLaunch', 'phone-new-session'),
    activeSessionId: null,
    sessions: [],
    newSession: {
        phase: 'compose',
        selectedProvider: 'OpenCode',
        machineId: 'm-macbook-pro',
        path: '/Users/demo/code/happier',
        prompt: '',
    },
};

export const remoteLaunchScenario: Scenario = {
    id: 'remoteLaunch',
    title: 'Remote launch',
    durationMs: 30_000,
    totalDuration: 30_000,
    initialBridgeState,
    beats: [
        createBeat({
            id: 'phone-new-session',
            atMs: 0,
            durationMs: 5_000,
            focus: 'phone',
            visibleSurfaces: ['phone-new-session', 'desktop-new-session'],
            state: {
                sessionTitle: 'New session',
                sessionMeta: 'MacBook Pro · online · /Users/demo/code/happier',
                activityChip: { device: 'phone', label: 'choose target Mac' },
            },
            bridgePatch: {
                newSession: {
                    phase: 'compose',
                    selectedProvider: 'OpenCode',
                    machineId: 'm-macbook-pro',
                    path: '/Users/demo/code/happier',
                    prompt: '',
                },
            },
        }),
        createBeat({
            id: 'select-opencode',
            atMs: 5_000,
            durationMs: 4_000,
            focus: 'phone',
            visibleSurfaces: ['phone-new-session', 'desktop-new-session'],
            state: {
                sessionTitle: 'OpenCode',
                sessionMeta: 'Worktree · MCP · permission chips',
                activityChip: { device: 'phone', label: 'OpenCode selected' },
            },
            bridgePatch: {
                newSession: {
                    phase: 'picking-agent',
                    selectedProvider: 'OpenCode',
                    machineId: 'm-macbook-pro',
                    path: '/Users/demo/code/happier',
                    prompt: '',
                },
            },
        }),
        createBeat({
            id: 'prompt-compose',
            atMs: 9_000,
            durationMs: 4_500,
            focus: 'phone',
            visibleSurfaces: ['phone-new-session', 'desktop-new-session'],
            state: {
                sessionTitle: 'OpenCode',
                sessionMeta: 'prompt ready',
                messages: [
                    {
                        id: 'remote-prompt',
                        role: 'user',
                        text: 'Implement the dashboard auth skeleton and open a PR.',
                    },
                ],
                activityChip: { device: 'phone', label: 'prompt composed' },
            },
            bridgePatch: {
                newSession: {
                    phase: 'compose',
                    selectedProvider: 'OpenCode',
                    machineId: 'm-macbook-pro',
                    path: '/Users/demo/code/happier',
                    prompt: 'Implement the dashboard auth skeleton and open a PR.',
                },
            },
        }),
        createBeat({
            id: 'daemon-start',
            atMs: 13_500,
            durationMs: 4_500,
            focus: 'phone-desktop',
            visibleSurfaces: ['phone-new-session', 'desktop-session'],
            state: {
                sessionTitle: 'OpenCode starting',
                sessionMeta: 'Starting on MacBook Pro...',
                activityChip: { device: 'desktop', label: 'Started by daemon' },
                syncPulseKey: 1,
            },
            bridgePatch: {
                activeSessionId: 's-opencode-auth',
                newSession: {
                    phase: 'starting',
                    selectedProvider: 'OpenCode',
                    machineId: 'm-macbook-pro',
                    path: '/Users/demo/code/happier',
                    prompt: 'Implement the dashboard auth skeleton and open a PR.',
                },
                sessions: [
                    {
                        id: 's-opencode-auth',
                        title: 'Dashboard auth skeleton',
                        provider: 'OpenCode',
                        status: 'starting',
                        machineId: 'm-macbook-pro',
                        path: '/Users/demo/code/happier',
                        startedBy: 'daemon',
                    },
                ],
                messagesBySession: {
                    's-opencode-auth': remoteLaunchPromptMessages,
                },
            },
            events: [{ id: 'daemon-started', type: 'session' }],
        }),
        createBeat({
            id: 'background-stream',
            atMs: 18_000,
            durationMs: 5_500,
            focus: 'desktop',
            visibleSurfaces: ['phone-session', 'desktop-session'],
            state: {
                sessionTitle: 'OpenCode running',
                sessionMeta: 'background process streaming',
                activityChip: { device: 'desktop', label: 'OpenCode running on MacBook Pro' },
                syncPulseKey: 2,
            },
            bridgePatch: {
                activeView: 'desktop-session',
                newSession: {
                    phase: 'running',
                    selectedProvider: 'OpenCode',
                    machineId: 'm-macbook-pro',
                    path: '/Users/demo/code/happier',
                    prompt: 'Implement the dashboard auth skeleton and open a PR.',
                },
                sessions: [
                    {
                        id: 's-opencode-auth',
                        title: 'Dashboard auth skeleton',
                        provider: 'OpenCode',
                        status: 'running',
                        machineId: 'm-macbook-pro',
                        path: '/Users/demo/code/happier',
                        startedBy: 'daemon',
                    },
                ],
                messagesBySession: {
                    's-opencode-auth': remoteLaunchRunningMessages,
                },
            },
            events: [{ id: 'background-stream', type: 'sync-pulse' }],
        }),
        createBeat({
            id: 'attach-terminal',
            atMs: 23_500,
            durationMs: 6_500,
            focus: 'terminal',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            terminal: {
                commands: ['happier attach s-opencode-auth'],
                attachedSessionId: 's-opencode-auth',
                cast: {
                    src: '/casts/opencode-prism.cast',
                    // The recording is 75s; speed=2 fits ~13s of streaming into
                    // the 6.5s beat, which carries the prompt + early response
                    // burst from the lib/telemetry summary.
                    speed: 2,
                    endAtSeconds: 30,
                },
                // Fallback lines for graceful degradation if the cast can't
                // be fetched, and so tests can still assert beat semantics.
                lines: [
                    { kind: 'user', text: '$ happier attach s-opencode-auth' },
                    { kind: 'info', text: 'Attaching to OpenCode provider session…', accent: 'blue' },
                    { kind: 'agent', text: 'opencode attach http://127.0.0.1:4096 --dir /Users/demo/code/happier --session oc_auth_42' },
                    { kind: 'info', text: 'Attached · server-backed OpenCode session', accent: 'green' },
                ],
            },
            state: {
                sessionTitle: 'OpenCode attach',
                sessionMeta: 'terminal attached later',
                activityChip: { device: 'terminal', label: 'happier attach s-opencode-auth' },
                syncPulseKey: 3,
            },
            bridgePatch: {
                activeView: 'desktop-session',
                newSession: {
                    phase: 'attach',
                    selectedProvider: 'OpenCode',
                    machineId: 'm-macbook-pro',
                    path: '/Users/demo/code/happier',
                    prompt: 'Implement the dashboard auth skeleton and open a PR.',
                },
                messagesBySession: {
                    's-opencode-auth': remoteLaunchRunningMessages,
                },
            },
        }),
    ],
};
