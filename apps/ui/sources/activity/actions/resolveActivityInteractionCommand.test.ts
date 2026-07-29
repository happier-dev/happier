import { HAPPIER_FOCUS_LIVE_ACTIVITY_NAME, PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

async function loadResolverModule() {
    return import('./resolveActivityInteractionCommand').catch(() => null);
}

describe('resolveActivityInteractionCommand', () => {
    it('routes session taps with a server-scoped live activity identity', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'open-session:session-1',
            defaultActionIdentifier: 'open-session:session-1',
            data: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            knownIdentities: [{
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            }],
        });

        expect(command).toEqual({
            kind: 'openSession',
            sessionId: 'session-1',
            serverId: 'server-a',
            serverUrl: null,
            route: '/session/session-1?serverId=server-a',
            identity: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
        });
    });

    it('routes encoded server-scoped session targets when session ids collide across servers', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'open-session:session-1?serverId=server-b',
            defaultActionIdentifier: 'open-inbox',
            data: {},
            knownIdentities: [
                {
                    serverId: 'server-a',
                    sessionId: 'session-1',
                    activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
                },
                {
                    serverId: 'server-b',
                    sessionId: 'session-1',
                    activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
                },
            ],
        });

        expect(command).toMatchObject({
            kind: 'openSession',
            sessionId: 'session-1',
            serverId: 'server-b',
            route: '/session/session-1?serverId=server-b',
            identity: {
                serverId: 'server-b',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
        });
    });

    it('executes permission actions with the same server-scoped identity as the live activity', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            defaultActionIdentifier: 'open-session:session-1',
            data: {
                serverId: 'server-a',
                sessionId: 'session-1',
                requestId: 'request-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            knownIdentities: [{
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            }],
        });

        expect(command).toMatchObject({
            kind: 'executeAction',
            actionId: 'session.permission.respond',
            defaultSessionId: 'session-1',
            identity: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            payload: {
                decision: 'allow',
                sessionId: 'session-1',
                requestId: 'request-1',
            },
        });
    });

    it('falls back to opening the session when direct actions are disabled for a verified target', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1,
            defaultActionIdentifier: 'open-session:session-1',
            data: {
                serverId: 'server-a',
                sessionId: 'session-1',
                requestId: 'request-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            knownIdentities: [{
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            }],
            directActionsEnabled: false,
        });

        expect(command).toMatchObject({
            kind: 'openSession',
            sessionId: 'session-1',
            serverId: 'server-a',
            route: '/session/session-1?serverId=server-a',
            fallbackReason: 'direct_actions_disabled',
        });
    });

    it('focuses the composer for verified focus-composer interactions', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'focus-composer:session-1?serverId=server-a',
            defaultActionIdentifier: 'open-session:session-1',
            data: {
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            knownIdentities: [{
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            }],
        });

        expect(command).toMatchObject({
            kind: 'focusComposer',
            sessionId: 'session-1',
            serverId: 'server-a',
            route: '/session/session-1?serverId=server-a',
        });
    });

    it('ignores malformed focus-composer interactions even when identity verification is disabled', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'focus-composer:',
            defaultActionIdentifier: 'open-inbox',
            data: {},
            requireKnownIdentity: false,
        });

        expect(command).toEqual({
            kind: 'ignore',
            reason: 'missing_identity',
        });
    });

    it('falls back safely when a session action names an unknown server identity', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'open-session:session-1',
            defaultActionIdentifier: 'open-session:session-1',
            data: {
                serverId: 'server-b',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            knownIdentities: [{
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            }],
        });

        expect(command).toEqual({
            kind: 'ignore',
            reason: 'unknown_server',
            target: {
                serverId: 'server-b',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
        });
    });

    it('falls back safely when no known server identities are available to verify the payload', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'open-session:session-1',
            defaultActionIdentifier: 'open-session:session-1',
            data: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            knownIdentities: [],
        });

        expect(command).toEqual({
            kind: 'ignore',
            reason: 'unknown_server',
            target: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
        });
    });

    it('falls back safely for unknown action payloads', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        const command = resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'unknown-action',
            defaultActionIdentifier: 'open-session:session-1',
            data: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
            knownIdentities: [{
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            }],
        });

        expect(command).toEqual({
            kind: 'ignore',
            reason: 'unknown_action',
            target: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            },
        });
    });

    it('opens inbox and settings destinations without requiring session identity', async () => {
        const resolver = await loadResolverModule();
        expect(resolver).not.toBeNull();
        if (!resolver) return;

        expect(resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'open-inbox',
            defaultActionIdentifier: 'open-inbox',
            data: {},
        })).toEqual({
            kind: 'openInbox',
            route: '/inbox',
        });

        expect(resolver.resolveActivityInteractionCommand({
            actionIdentifier: 'open-settings:notifications',
            defaultActionIdentifier: 'open-inbox',
            data: {},
        })).toEqual({
            kind: 'openSettings',
            route: '/settings/notifications',
            destination: 'notifications',
            diagnostics: null,
        });
    });
});
