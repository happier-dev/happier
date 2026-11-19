import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import { createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildActivityOverviewFromCandidates } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildActivityOverviewFromSource } from '../source/buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from '../source/activityAttentionSourceTypes';
import { resolveActivitySurfaceDeliveryAdmission as admitActivitySurface } from './resolveActivitySurfaceDeliveryAdmission';
import type { ExactHomeAccountSettingsResolver } from './useExactHomeAccountSettings';

const NOW = new Date('2026-05-03T12:00:00.000Z');
const HOME_A = 'server-a';
const HOME_B = 'server-b';
/** The same Session ID on both Homes: admission must never collapse the two. */
const SHARED_SESSION_ID = 'shared-session';
const B_ONLY_SESSION_ID = 'session-b-only';
const AUDIENCE_SCOPES = new Map([HOME_A, HOME_B].map(serverId => [serverId, { serverId, accountId: `account-${serverId}` }]));
function resolveActivitySurfaceDeliveryAdmission(params: Parameters<typeof admitActivitySurface>[0]) {
    return admitActivitySurface({ audienceScopes: AUDIENCE_SCOPES,
        accountDeliveryMutesByServerId: Object.fromEntries([...AUDIENCE_SCOPES].map(([serverId, scope]) => [serverId, { scope, scopes: [] }])),
        ...params });
}

function createHomeSession(serverId: string, sessionId: string, attention: boolean): Session {
    return createSessionFixture({
        id: sessionId,
        serverId,
        active: true,
        updatedAt: 1_000,
        ...(attention
            ? {
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: 950,
                pendingVersion: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: {},
                            createdAt: 950,
                        },
                    },
                },
            }
            : {}),
    } as Partial<Session>);
}

function createTwoHomeSource(): ActivityAttentionSource {
    const sessions: ReadonlyArray<Readonly<{ serverId: string; session: Session }>> = [
        // Attention lives only on Home B. Home A stays quiet so a leak is visible.
        { serverId: HOME_A, session: createHomeSession(HOME_A, SHARED_SESSION_ID, false) },
        { serverId: HOME_B, session: createHomeSession(HOME_B, SHARED_SESSION_ID, true) },
        { serverId: HOME_B, session: createHomeSession(HOME_B, B_ONLY_SESSION_ID, true) },
    ];
    const sessionListRowsByServerId: Record<string, Record<string, ReturnType<typeof buildSessionListRenderableFromSession>>> = {};
    const ordinarySessionListMembershipByServerId: Record<string, string[]> = {};
    const sessionListIndexByServerId: Record<string, Array<{ type: 'session'; sessionId: string; serverId: string }>> = {};
    for (const { serverId, session } of sessions) {
        (sessionListRowsByServerId[serverId] ??= {})[session.id] = buildSessionListRenderableFromSession(session);
        (ordinarySessionListMembershipByServerId[serverId] ??= []).push(session.id);
        (sessionListIndexByServerId[serverId] ??= []).push({
            type: 'session',
            sessionId: session.id,
            serverId,
        });
    }

    return {
        isDataReady: true,
        // Only Home B's copy is hydrated; the shared ID must still resolve per Home.
        sessionsById: Object.fromEntries(sessions
            .filter(({ serverId }) => serverId === HOME_B)
            .map(({ session }) => [session.id, session])),
        sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId,
        sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: {},
        activeServerId: HOME_B,
        activeServer: { serverId: HOME_B, serverUrl: 'https://home-b.example', generation: 1 },
    } as ActivityAttentionSource;
}

function createResolver(
    settingsByServerId: Readonly<Record<string, Record<string, unknown>>>,
): ExactHomeAccountSettingsResolver {
    return (serverId) => {
        const raw = typeof serverId === 'string' ? settingsByServerId[serverId.trim()] : undefined;
        return raw ? accountSettingsParse(raw) : null;
    };
}

function candidateAddresses(candidates: ReturnType<typeof buildActivityOverviewFromSource>['candidates']) {
    return candidates.map((candidate) => `${candidate.serverId ?? ''}/${candidate.sessionId}`).sort();
}

const LOCAL_SETTINGS = localSettingsParse({});

describe('resolveActivitySurfaceDeliveryAdmission', () => {
    it('suppresses only the muted Home source and fails unavailable delivery closed without changing source attention', () => {
        const candidates = [HOME_A, HOME_B].map(serverId => buildSessionActivityAttention({
            session: createHomeSession(serverId, SHARED_SESSION_ID, true), nowMs: NOW.getTime(),
        }));
        const originalAttention = candidates.map(candidate => candidate.personalAttention);
        const input = { candidates, surface: 'desktop_overlay' as const,
            resolveAccountSettings: createResolver({ [HOME_A]: {}, [HOME_B]: {} }), localSettings: LOCAL_SETTINGS, now: NOW,
            accountDeliveryMutesByServerId: {
                [HOME_A]: { scope: AUDIENCE_SCOPES.get(HOME_A)!, scopes: [{ kind: 'sender_session' as const, sessionId: SHARED_SESSION_ID }] },
                [HOME_B]: { scope: AUDIENCE_SCOPES.get(HOME_B)!, scopes: [] },
            },
        };
        expect(candidateAddresses(resolveActivitySurfaceDeliveryAdmission(input).candidates)).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(resolveActivitySurfaceDeliveryAdmission({ ...input,
            accountDeliveryMutesByServerId: { ...input.accountDeliveryMutesByServerId, [HOME_B]: null },
        }).candidates).toEqual([]);
        expect(resolveActivitySurfaceDeliveryAdmission({ ...input, accountDeliveryMutesByServerId: {
            ...input.accountDeliveryMutesByServerId, [HOME_B]: { scope: { serverId: HOME_B, accountId: 'replaced-account' }, scopes: [] },
        } }).candidates).toEqual([]);
        expect(candidates.map(candidate => candidate.personalAttention)).toEqual(originalAttention);
    });
    it('unions admitted rule policies without rewriting viewer facts and refreshes delivery when only a rule changes', () => {
        const session = createSessionFixture({ id: 'rule-follow', serverId: HOME_A,
            access: createSessionAccessFixture('edit'), pendingUserActionRequestCount: 1,
            agentState: { requests: { question: { kind: 'user_action', tool: 'AskUserQuestion', arguments: {}, createdAt: 1 } } },
            viewer: createSessionViewerFixture({ follow: { follows: false, notificationLevel: null },
                attention: { needsAttention: false, primary: null, reasons: [], presentation: 'full' } }),
        });
        const candidate = (interrupt: boolean) => buildSessionActivityAttention({ session, nowMs: NOW.getTime(),
            followRulePolicies: [{ preset: 'custom', events: { needs_you: { decision: { delivery: interrupt ? 'interrupt' : 'quiet' } } } }],
        });
        const quiet = candidate(false);
        const interrupt = candidate(true);
        expect(quiet.hasAttention).toBe(true);
        expect(interrupt.personalAttention).toEqual(quiet.personalAttention);
        const admit = (value: typeof quiet) => resolveActivitySurfaceDeliveryAdmission({ candidates: [value],
            surface: 'desktop_overlay', resolveAccountSettings: createResolver({ [HOME_A]: {} }), localSettings: LOCAL_SETTINGS, now: NOW,
        }).candidates;
        expect(admit(quiet)).toHaveLength(0);
        expect(admit(interrupt)).toHaveLength(1);
        expect(buildActivityOverviewFromCandidates([quiet]).fingerprint)
            .not.toEqual(buildActivityOverviewFromCandidates([interrupt]).fingerprint);
        expect(interrupt.session).toBe(session);
        expect(session.viewer?.follow).toEqual({ follows: false, notificationLevel: null });
    });
    it('retains source attention without inventing interrupt intent for an unopened question', () => {
        const session = createSessionFixture({ id: 'unopened-question', serverId: HOME_A, active: true,
            agentState: null, pendingUserActionRequestCount: 1,
            viewer: createSessionViewerFixture({ follow: { follows: true, notificationLevel: 'important', policy: { preset: 'important' } },
                attention: { needsAttention: true, primary: 'user_action_required', reasons: ['user_action_required'], presentation: 'status_only' } }),
        });
        const candidate = buildSessionActivityAttention({ session, nowMs: NOW.getTime() });
        expect(candidate.hasAttention).toBe(true);
        expect(resolveActivitySurfaceDeliveryAdmission({ candidates: [candidate],
            surface: 'desktop_overlay', resolveAccountSettings: createResolver({ [HOME_A]: {} }), localSettings: LOCAL_SETTINGS, now: NOW,
        }).candidates).toHaveLength(0);
    });
    it('interrupts only the accepted one-shot turn and never a later same-kind turn', () => {
        const session = createSessionFixture({ id: 'once', serverId: HOME_A, latestTurnId: 'captured-turn', latestTurnStatus: 'completed',
            viewer: createSessionViewerFixture({ follow: { follows: false, notificationLevel: 'none',
                onceDelivery: { event: 'ready', turnId: 'captured-turn', agentStateVersion: 1 } },
                attention: { needsAttention: true, primary: 'ready_after_read', reasons: ['ready_after_read'], presentation: 'full' } }),
        });
        const admit = (value: Session) => resolveActivitySurfaceDeliveryAdmission({
            candidates: [buildSessionActivityAttention({ session: value, nowMs: NOW.getTime() })],
            surface: 'desktop_overlay', resolveAccountSettings: createResolver({ [HOME_A]: {} }), localSettings: LOCAL_SETTINGS, now: NOW,
        }).candidates;
        expect(admit(session)).toHaveLength(1);
        expect(admit({ ...session, latestTurnId: 'next-turn' })).toHaveLength(0);
    });
    it('uses the actual question mode, subtype and current handler for a pending request', () => {
        const admit = (question: { mode: 'wait' | 'continue'; type: 'blocked' | 'decision'; assumption?: string }, handler: { kind: 'person' } | { kind: 'session'; sessionId: string }, important = false) => {
            const session = createSessionFixture({ id: 'question', serverId: HOME_A, active: true,
                viewer: createSessionViewerFixture({ follow: { follows: true, notificationLevel: 'important',
                    policy: important ? { preset: 'important' } : { preset: 'custom', events: { needs_you: { blocked: { delivery: 'interrupt' } } } } },
                    attention: { needsAttention: true, primary: 'user_action_required', reasons: ['user_action_required'], presentation: 'full' } }),
                agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1,
                    questionV1: { ...question, lasting: true }, currentHandler: handler } } },
            });
            return resolveActivitySurfaceDeliveryAdmission({
                candidates: [buildSessionActivityAttention({ session, nowMs: NOW.getTime() })],
                surface: 'desktop_overlay', resolveAccountSettings: createResolver({ [HOME_A]: {} }), localSettings: LOCAL_SETTINGS, now: NOW,
            }).candidates;
        };
        expect(admit({ mode: 'wait', type: 'blocked' }, { kind: 'person' })).toHaveLength(1);
        expect(admit({ mode: 'wait', type: 'decision' }, { kind: 'person' })).toHaveLength(0);
        expect(admit({ mode: 'wait', type: 'blocked' }, { kind: 'session', sessionId: 'manager' })).toHaveLength(0);
        expect(admit({ mode: 'wait', type: 'decision' }, { kind: 'person' }, true)).toHaveLength(1);
        expect(admit({ mode: 'continue', type: 'decision', assumption: 'Use current revision' }, { kind: 'person' }, true)).toHaveLength(0);
    });
    const overview = buildActivityOverviewFromSource({
        source: createTwoHomeSource(),
        nowMs: NOW.getTime(),
        activityName: 'HappierFocusLiveActivity',
    });

    it('builds both Homes as candidates before delivery policy is applied', () => {
        expect(candidateAddresses(overview.candidates)).toEqual([
            `${HOME_A}/${SHARED_SESSION_ID}`,
            `${HOME_B}/${B_ONLY_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
    });

    it('admits and projects privacy per originating Home with inverse Account policies', () => {
        const resolveAccountSettings = createResolver({
            // Home A disabled Live Activities but allows full previews on widgets.
            [HOME_A]: {
                attentionDeliveryPolicyV1: {
                    v: 1,
                    channels: { live_activity: { enabled: false } },
                    privacy: { surfaces: { home_widget: 'include_preview' } },
                },
            },
            // Home B is the mirror image. Its Live Activity privacy is stated at the
            // event level because the canonical owner deliberately lets an explicit
            // request-preview rule outrank a surface default.
            [HOME_B]: {
                attentionDeliveryPolicyV1: {
                    v: 1,
                    channels: { home_widget: { enabled: false } },
                    // Stated at both levels: the canonical owner lets an explicit
                    // request-preview rule outrank a surface default, and the surface
                    // default still governs this Home's non-request candidates.
                    events: { permission_request: { previewBehavior: 'status_only' } },
                    privacy: { surfaces: { live_activity: 'status_only', home_widget: 'include_preview' } },
                },
            },
        });

        const liveActivity = resolveActivitySurfaceDeliveryAdmission({
            candidates: overview.candidates,
            surface: 'live_activity',
            resolveAccountSettings,
            localSettings: LOCAL_SETTINGS,
            now: NOW,
        });
        const homeWidget = resolveActivitySurfaceDeliveryAdmission({
            candidates: overview.candidates,
            surface: 'home_widget',
            resolveAccountSettings,
            localSettings: LOCAL_SETTINGS,
            now: NOW,
        });

        expect(candidateAddresses(liveActivity.candidates)).toEqual([
            `${HOME_B}/${B_ONLY_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
        expect(candidateAddresses(homeWidget.candidates)).toEqual([`${HOME_A}/${SHARED_SESSION_ID}`]);
        for (const candidate of liveActivity.candidates) {
            expect(liveActivity.privacyModeFor(candidate)).toBe('status_only');
        }
        expect(homeWidget.privacyModeFor(homeWidget.candidates[0]!)).toBe('include_preview');
    });

    it('leaves one Home unchanged when the other Home rewrites its Account policy', () => {
        const bPolicy = {
            attentionDeliveryPolicyV1: {
                v: 1,
                events: { permission_request: { previewBehavior: 'title_only' } },
                privacy: { surfaces: { live_activity: 'title_only' } },
            },
        };
        const readHomeB = (aPolicy: Record<string, unknown>) => {
            const admission = resolveActivitySurfaceDeliveryAdmission({
                candidates: overview.candidates,
                surface: 'live_activity',
                resolveAccountSettings: createResolver({ [HOME_A]: aPolicy, [HOME_B]: bPolicy }),
                localSettings: LOCAL_SETTINGS,
                now: NOW,
            });
            const homeBCandidates = admission.candidates.filter((candidate) => candidate.serverId === HOME_B);
            return homeBCandidates.map((candidate) => admission.privacyModeFor(candidate));
        };

        expect(readHomeB({})).toEqual(['title_only', 'title_only']);
        expect(readHomeB({
            attentionDeliveryPolicyV1: {
                v: 1,
                channels: { live_activity: { enabled: false } },
                events: { permission_request: { previewBehavior: 'include_preview' } },
                privacy: { surfaces: { live_activity: 'include_preview' } },
            },
        })).toEqual(['title_only', 'title_only']);
    });

    it('fails closed for a Home with no resolvable Account settings', () => {
        const admission = resolveActivitySurfaceDeliveryAdmission({
            candidates: overview.candidates,
            surface: 'live_activity',
            resolveAccountSettings: createResolver({ [HOME_B]: {} }),
            localSettings: LOCAL_SETTINGS,
            now: NOW,
        });

        expect(candidateAddresses(admission.candidates)).toEqual([
            `${HOME_B}/${B_ONLY_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
        const homeACandidate = overview.candidates.find((candidate) => candidate.serverId === HOME_A);
        expect(admission.privacyModeFor(homeACandidate!)).toBeNull();
    });

    it('binds explicit opens to the exact Account, desktop channel and privacy even without mute facts', () => {
        const scope = AUDIENCE_SCOPES.get(HOME_B)!;
        const admit = (accountId: string, enabled: boolean) => resolveActivitySurfaceDeliveryAdmission({
            candidates: overview.candidates.filter(candidate => candidate.sessionId === SHARED_SESSION_ID),
            surface: 'desktop_overlay',
            intent: { kind: 'explicit_open', scope: { serverId: HOME_B, accountId } },
            accountDeliveryMutesByServerId: {},
            resolveAccountSettings: createResolver({
                [HOME_A]: {},
                [HOME_B]: { attentionDeliveryPolicyV1: {
                    v: 1, channels: { desktop_overlay: { enabled } },
                    privacy: { surfaces: { desktop_overlay: 'status_only' } },
                } },
            }),
            localSettings: LOCAL_SETTINGS,
            now: NOW,
        });

        const allowed = admit(scope.accountId, true);
        expect(candidateAddresses(allowed.candidates)).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(allowed.privacyModeFor(allowed.candidates[0]!)).toBe('status_only');
        expect(admit(AUDIENCE_SCOPES.get(HOME_A)!.accountId, true).candidates).toEqual([]);
        expect(admit(scope.accountId, false).candidates).toEqual([]);
    });

    it('suppresses a Home whose Account quiet hours suppress the surface', () => {
        const quietHours = {
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '08:00', endLocalTime: '20:00' }],
                },
                channels: { home_widget: { quietHoursBehavior: 'suppress' } },
            },
        };
        const admission = resolveActivitySurfaceDeliveryAdmission({
            candidates: overview.candidates,
            surface: 'home_widget',
            resolveAccountSettings: createResolver({ [HOME_A]: {}, [HOME_B]: quietHours }),
            localSettings: LOCAL_SETTINGS,
            now: NOW,
        });

        expect(candidateAddresses(admission.candidates)).toEqual([`${HOME_A}/${SHARED_SESSION_ID}`]);
    });

    it('lets a device privacy override narrow every Home Account policy', () => {
        const admission = resolveActivitySurfaceDeliveryAdmission({
            candidates: overview.candidates,
            surface: 'live_activity',
            resolveAccountSettings: createResolver({
                [HOME_A]: { attentionDeliveryPolicyV1: { v: 1, privacy: { surfaces: { live_activity: 'include_preview' } } } },
                [HOME_B]: { attentionDeliveryPolicyV1: { v: 1, privacy: { surfaces: { live_activity: 'include_preview' } } } },
            }),
            localSettings: localSettingsParse({
                attentionDeviceOverridesV1: { v: 1, liveActivities: { privacyMode: 'status_only' } },
            }),
            now: NOW,
        });

        expect(admission.candidates.length).toBe(3);
        for (const candidate of admission.candidates) {
            expect(admission.privacyModeFor(candidate)).toBe('status_only');
        }
    });
});
