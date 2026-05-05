import type { Scenario } from '../timeline/types';
import type { TerminalTypingPrompt } from '../timeline/scenarioTypes';
import { createBeat, createInitialBridgeState } from './scenarioFixtures';
import { authSkeletonMessagesWithFollowUp } from './demoTranscriptFixtures';

/**
 * Handoff scenario — the "one session, every device" story.
 *
 * Beat arc (~17s, nine beats):
 *   1. start            terminal hero — typing cycles through providers
 *   2. claude-works     terminal hero — Claude streams the task
 *   3. step-away        terminal hero — agent keeps editing on its own
 *   4. finished-notif   phone hero    — Dynamic Island brings the alert
 *   5. refine-typing    phone hero    — composer types the refinement
 *   6. refine-sent      phone hero    — message lands in transcript
 *   7. continuity       all three     — same session everywhere
 *   8. permission-lands all three     — permission shows on every device
 *   9. approve-desktop  desktop hero  — user approves from desktop
 *  10. rest             all three     — settle before loop
 *
 * Each beat is now 1.4–2.0s — tight, keynote-fast pacing. The cinematic
 * stage's spring transitions (~450ms) overlap into the next beat so the
 * story keeps moving.
 *
 * Each beat references real screenshots of the live Happier app (in
 * `apps/website/public/images/demo/sessions/`) for the phone and desktop
 * frames. The terminal frame still uses scripted lines — that one isn't
 * worth screenshotting because the terminal IS the website's chrome.
 */

const typingPrompt: TerminalTypingPrompt = {
    prefix: 'happier ',
    tokens: ['claude', 'codex', 'opencode', 'claude'],
    perCharMs: 28,
    backspaceMs: 18,
    flashMs: 90,
    holdFinalMs: 320,
};

// Asset roots — keeps beat declarations readable.
const PHONE = {
    sessionList: '/images/demo/sessions/phone-session-list.png',
    patioSettingsTop: '/images/demo/sessions/phone-patio-settings.png',
    patioSettingsMid: '/images/demo/sessions/phone-patio-settings-mid.png',
    permissionClaude: '/images/demo/sessions/phone-permission-card-claude.png',
    rateLimitingMid: '/images/demo/sessions/phone-atlas-rate-limiting-mid.png',
} as const;

const DESKTOP = {
    sessionList: '/images/demo/sessions/desktop-session-list.png',
    patioSettings: '/images/demo/sessions/desktop-patio-settings.png',
    permissionClaude: '/images/demo/sessions/desktop-permission-card-claude.png',
    rateLimitingMid: '/images/demo/sessions/desktop-atlas-rate-limiting-mid.png',
} as const;

export const handoffScenario: Scenario = {
    id: 'handoff',
    title: 'One session, every device',
    durationMs: 18_800,
    totalDuration: 18_800,
    initialBridgeState: createInitialBridgeState('handoff', 'phone-session'),
    beats: [
        // 1. Start — terminal hero, typewriter cycles through providers (~1.7s)
        createBeat({
            id: 'start',
            atMs: 0,
            durationMs: 1_700,
            focus: 'terminal',
            visibleSurfaces: ['terminal'],
            label: 'Start any provider — Claude, Codex, OpenCode.',
            terminal: {
                typingPrompt,
                lines: [],
            },
            state: {
                sessionTitle: 'New session',
                sessionMeta: 'choose provider',
            },
            media: {
                phone: { kind: 'image', src: PHONE.sessionList, alt: 'Happier sessions on iPhone' },
                desktop: { kind: 'image', src: DESKTOP.sessionList, alt: 'Happier sessions on desktop' },
            },
        }),

        // 2. Claude works — terminal hero, real Claude Code TUI replay
        //    via asciinema cast. The cast captures actual `hdev claude` output
        //    so the viewer sees the genuine prompt box, streaming, and
        //    syntax-highlighted diffs rather than a synthetic mock.
        createBeat({
            id: 'claude-works',
            atMs: 1_700,
            durationMs: 5_000,
            focus: 'terminal',
            visibleSurfaces: ['terminal'],
            label: 'Your agent gets to work.',
            terminal: {
                cast: {
                    src: '/casts/claude-patio.cast',
                    // The cast was post-processed by trimCast.py to drop the
                    // 70s of TUI boot, so it now starts at the first rendered
                    // frame. Real-time playback is fine for 6s of prompt typing.
                    speed: 1,
                },
                lines: [],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'Claude · streaming',
                messageCount: 2,
            },
            media: {
                phone: { kind: 'image', src: PHONE.sessionList },
                desktop: { kind: 'image', src: DESKTOP.sessionList },
            },
        }),

        // 3. Step away — terminal still hero, agent keeps editing (~1.4s)
        createBeat({
            id: 'step-away',
            atMs: 6_700,
            durationMs: 1_400,
            focus: 'terminal',
            visibleSurfaces: ['terminal'],
            label: 'Step away — your agent keeps going.',
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'agent', text: 'Reviewing auth flow', accent: 'green' },
                    { kind: 'tool', text: 'Editing app/(dashboard)/layout.tsx' },
                    { kind: 'tool', text: 'Editing components/auth/skeleton.tsx' },
                    { kind: 'agent', text: 'Wiring the skeleton through the providers…' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'Claude · running on MacBook Pro',
                messageCount: 4,
            },
            media: {
                phone: { kind: 'image', src: PHONE.sessionList },
                desktop: { kind: 'image', src: DESKTOP.sessionList },
            },
        }),

        // 4. Finished notification — phone hero, Dynamic Island arrives (~1.8s).
        //    Camera punches in on the phone so the notification is the focal
        //    point. Phone sits at +200px x in partner-right; we offset by 200
        //    (which translates -200 after zoom) so the phone centers.
        createBeat({
            id: 'finished-notif',
            atMs: 8_100,
            durationMs: 1_800,
            focus: 'phone',
            visibleSurfaces: ['terminal', 'phone-session'],
            label: 'Happier pings your phone the moment it’s done.',
            camera: { zoom: 1.35, offsetX: 200 },
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'agent', text: 'Wired skeleton through dashboard providers.', accent: 'green' },
                    { kind: 'info', text: 'Ready for review.', accent: 'dim' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'finished a pass',
                phoneNotification: {
                    phase: 'arriving',
                    title: 'Claude finished a pass',
                    body: 'Dashboard auth skeleton is ready for review.',
                    actionLabel: 'Open',
                },
                syncPulseKey: 1,
                syncDirection: 'forward',
            },
            events: [{ id: 'finish-sync', type: 'sync-pulse' }],
            media: {
                phone: { kind: 'image', src: PHONE.sessionList },
                desktop: { kind: 'image', src: DESKTOP.sessionList },
            },
        }),

        // 5. Refine typing — phone hero, composer types the refinement (~1.4s)
        createBeat({
            id: 'refine-typing',
            atMs: 9_900,
            durationMs: 1_400,
            focus: 'phone',
            visibleSurfaces: ['terminal', 'phone-session'],
            label: 'Send a refinement, right from your phone.',
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'info', text: 'session is live on iPhone', accent: 'dim' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'refining from phone',
                phoneNotification: {
                    phase: 'opened',
                    title: 'Opening session',
                    body: 'Same Claude Code session, live on phone.',
                },
                messages: [],
                messageCount: 4,
                activityChip: { device: 'phone', label: 'typing' },
            },
            media: {
                phone: { kind: 'image', src: PHONE.patioSettingsTop, alt: 'Happier session on phone' },
                desktop: { kind: 'image', src: DESKTOP.sessionList },
            },
        }),

        // 6. Refine sent — message lands, transcript advances (~1.0s)
        createBeat({
            id: 'refine-sent',
            atMs: 11_300,
            durationMs: 1_000,
            focus: 'phone',
            visibleSurfaces: ['terminal', 'phone-session'],
            label: 'Send a refinement, right from your phone.',
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'info', text: 'received from iPhone', accent: 'dim' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'message sent',
                phoneNotification: {
                    phase: 'opened',
                    title: 'Opening session',
                    body: 'Same Claude Code session, live on phone.',
                },
                messages: [
                    {
                        id: 'm-follow-up',
                        role: 'user',
                        text: 'also add a skeleton loader while auth resolves',
                    },
                ],
                messageCount: 5,
                syncPulseKey: 2,
                syncDirection: 'back',
            },
            bridgePatch: {
                messagesBySession: {
                    's-auth-skeleton': authSkeletonMessagesWithFollowUp,
                },
            },
            events: [{ id: 'follow-up-sync', type: 'message' }],
            media: {
                phone: { kind: 'image', src: PHONE.patioSettingsMid, alt: 'Tool calls visible mid-transcript' },
                desktop: { kind: 'image', src: DESKTOP.sessionList },
            },
        }),

        // 7. Continuity — all three devices visible, same session (~1.6s)
        createBeat({
            id: 'continuity',
            atMs: 12_300,
            durationMs: 1_600,
            focus: 'all',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            label: 'Same session — laptop, phone, desktop app.',
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'tool', text: 'Editing components/auth/skeleton.tsx', accent: 'blue' },
                    { kind: 'agent', text: 'Adding a fade-in once auth resolves.' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'in sync · 3 devices',
                syncPulseKey: 3,
                syncDirection: 'forward',
            },
            bridgePatch: {
                messagesBySession: {
                    's-auth-skeleton': authSkeletonMessagesWithFollowUp,
                },
            },
            events: [{ id: 'continuity-sync', type: 'sync-pulse' }],
            media: {
                phone: { kind: 'image', src: PHONE.patioSettingsTop },
                desktop: { kind: 'image', src: DESKTOP.patioSettings, alt: 'Same session in the desktop app' },
            },
        }),

        // 8. Permission lands — appears on every device (~1.8s)
        createBeat({
            id: 'permission-lands',
            atMs: 13_900,
            durationMs: 1_800,
            focus: 'all',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            label: 'Get permission requests on every device.',
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'tool', text: 'Editing components/auth/skeleton.tsx', accent: 'blue' },
                    { kind: 'permission', text: 'Claude wants to edit DashboardShell.tsx', accent: 'orange' },
                    { kind: 'info', text: 'Waiting for approval…', accent: 'dim' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'permission requested',
                permission: {
                    id: 'p-dashboard-shell',
                    agent: 'Claude',
                    verb: 'edit',
                    target: 'DashboardShell.tsx',
                    state: 'pending',
                    diffPreview: { added: 31, removed: 7, path: 'DashboardShell.tsx' },
                },
                syncPulseKey: 4,
                syncDirection: 'forward',
            },
            bridgePatch: {
                messagesBySession: {
                    's-auth-skeleton': authSkeletonMessagesWithFollowUp,
                },
                permissionsBySession: {
                    's-auth-skeleton': {
                        id: 'p-dashboard-shell',
                        agent: 'Claude',
                        verb: 'edit',
                        target: 'DashboardShell.tsx',
                        state: 'pending',
                    },
                },
            },
            events: [{ id: 'permission-sync', type: 'sync-pulse' }],
            media: {
                // NOTE: videos disabled until we can record from a logged-in
                // browser context. agent-browser's record start opens a fresh
                // context that loses the dev-key auth, so videos showed the
                // login page. Stills below ARE the correct authenticated UI.
                phone: { kind: 'image', src: PHONE.permissionClaude, alt: 'Permission request on phone' },
                desktop: { kind: 'image', src: DESKTOP.permissionClaude, alt: 'Permission request on desktop' },
            },
        }),

        // 9. Approve from DESKTOP — desktop hero (~1.6s).
        //    Camera punches in on the desktop frame (partner-right at +260)
        //    so the approval action reads as the focal beat. The next beat
        //    (rest) lets it pull back out to the wide triptych for closure.
        createBeat({
            id: 'approve-desktop',
            atMs: 15_700,
            durationMs: 1_600,
            focus: 'desktop',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            label: 'Approve from any device — desktop this time.',
            camera: { zoom: 1.3, offsetX: 260 },
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'info', text: '✓ approved from desktop', accent: 'green' },
                    { kind: 'tool', text: 'Edited DashboardShell.tsx' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'approved on desktop',
                permission: {
                    id: 'p-dashboard-shell',
                    agent: 'Claude',
                    verb: 'edit',
                    target: 'DashboardShell.tsx',
                    state: 'approved',
                    diffPreview: { added: 31, removed: 7, path: 'DashboardShell.tsx' },
                },
                syncPulseKey: 5,
                syncDirection: 'back',
            },
            bridgePatch: {
                messagesBySession: {
                    's-auth-skeleton': authSkeletonMessagesWithFollowUp,
                },
                permissionsBySession: {
                    's-auth-skeleton': {
                        id: 'p-dashboard-shell',
                        agent: 'Claude',
                        verb: 'edit',
                        target: 'DashboardShell.tsx',
                        state: 'approved',
                        diffPreview: { added: 31, removed: 7, path: 'DashboardShell.tsx' },
                    },
                },
            },
            events: [{ id: 'desktop-approve-sync', type: 'sync-pulse' }],
            media: {
                phone: { kind: 'image', src: PHONE.permissionClaude },
                desktop: { kind: 'image', src: DESKTOP.permissionClaude },
            },
        }),

        // 10. Rest — final state, brief settle before loop (~1.5s)
        createBeat({
            id: 'rest',
            atMs: 17_300,
            durationMs: 1_500,
            focus: 'all',
            visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
            label: 'One session. Every device.',
            terminal: {
                cast: { src: '/casts/claude-patio.cast' },
                lines: [
                    { kind: 'info', text: 'session live on macbook-pro, iPhone, desktop', accent: 'dim' },
                ],
            },
            state: {
                sessionTitle: 'Dashboard auth skeleton',
                sessionMeta: 'in sync',
            },
            bridgePatch: {
                messagesBySession: {
                    's-auth-skeleton': authSkeletonMessagesWithFollowUp,
                },
            },
            media: {
                phone: { kind: 'image', src: PHONE.patioSettingsTop },
                desktop: { kind: 'image', src: DESKTOP.patioSettings },
            },
        }),
    ],
};
