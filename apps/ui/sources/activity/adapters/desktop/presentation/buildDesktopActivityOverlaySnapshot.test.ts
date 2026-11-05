import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { activityInstanceKey } from '@/sync/domains/session/sessionAddress';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import { buildDesktopActivityOverlaySnapshot } from './buildDesktopActivityOverlaySnapshot';
import type { DesktopActivityOverlaySource } from '../runtime/useDesktopActivityOverlaySource';
import { buildDesktopActivityOverlayRequestSnapshots } from './snapshot/buildDesktopActivityOverlayRequestSnapshots';
import { resolveDesktopActivityOverlayRequestCardActions } from '../ui/cards/resolveDesktopActivityOverlayCardActions';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';

const EMPTY_SHARED_ACTIVITY = { visible: false, activity: 'quiet', word: '', entries: [], tray: [] } as const;

function createDesktopPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    return {
        enabled: true,
        visibilityMode: 'attention_only',

        alwaysOnTop: true,

        hoverExpandDelayMs: 500,

        dock: 'top',
        idle: 'tip',
        botConversationPresentation: 'overlay',

        quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
        ...overrides,
    };
}

function createOverlaySource(params: Readonly<{
    sessions: ReadonlyArray<ReturnType<typeof createSessionFixture>>;
    quotaSummaries?: ReadonlyArray<ConnectedServiceQuotaSummary>;
}>): DesktopActivityOverlaySource {
    const sessions = params.sessions.map((session) => ({
        ...session,
        serverId: session.serverId ?? 'server-1',
    }));
    return {
        isDataReady: true,
        sessionsById: Object.fromEntries(sessions.map((session) => [session.id, session])),
        sessionListRowsByServerId: {
            'server-1': Object.fromEntries(
                sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)]),
            ),
        },
        ordinarySessionListMembershipByServerId: {
            'server-1': sessions.map((session) => session.id),
        },
        sessionListIndexByServerId: {
            'server-1': sessions.map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-1',
            })),
        },
        concurrentSessionListCacheByServerId: {},
        activeServerId: 'server-1',
        activeServer: {
            serverId: 'server-1',
            serverUrl: 'https://server-1.example.test',
            generation: 1,
        },
        quotaSummaries: params.quotaSummaries ?? [],
    };
}

describe('buildDesktopActivityOverlaySnapshot', () => {
    it('keeps the Session catalog Always allow choice for an external MCP ask', () => {
        const mcpTool = ResolvedMcpToolIdentityV1Schema.parse({ server: 'github', tool: 'edit_file',
            item: { serverId: 'github' }, serverTitle: 'GitHub',
            decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
        const session = createSessionFixture({ id: 'mcp-session', serverId: 'server-1', active: true,
            metadata: { path: '/tmp/notch-choice-parity', host: 'qa', flavor: 'claude' },
            agentState: { requests: { mcp: { tool: 'mcp__github__edit_file', kind: 'permission',
                arguments: {}, mcpTool, createdAt: 950 } } },
        });
        const source = { ...createOverlaySource({ sessions: [session] }),
            audienceScopes: new Map([['server-1', { serverId: 'server-1', accountId: 'account-1' }]]) };
        const snapshot = buildDesktopActivityOverlaySnapshot({ source,
            sourceOverview: { candidates: [buildSessionActivityAttention({ session, nowMs: 1_000 })],
                counts: { unread: 0, permissionRequired: 1, actionRequired: 0, thinking: 0, totalAttention: 1 } },
            activityPolicy: resolveActivitySurfacePolicy({}), desktopPolicy: createDesktopPolicy(), nowMs: 1_000 });
        expect(snapshot.permissionRequests[0]?.permissionChoices?.map(choice => choice.id)).toContain('mcp_always_allow');
        const model = buildDesktopActivityOverlayModel({ snapshot, policy: createDesktopPolicy(), sharedActivity: EMPTY_SHARED_ACTIVITY });
        const card = model.expanded.cards?.find(card => card.kind === 'permission_request');
        expect(card?.actions?.find(action => action.id === 'mcp_always_allow')).toMatchObject({
            actionIdentifier: 'overlay-mcp-always-allow', data: { sessionId: 'mcp-session', requestId: 'mcp', serverId: 'server-1' },
        });
    });
    it.each([
        { flavor: 'codex', ownerMetadata: false }, { flavor: 'claude', ownerMetadata: false },
        { flavor: 'codex', ownerMetadata: true }, { flavor: 'claude', ownerMetadata: true },
    ])('offers the Session choices for a $flavor file edit (owner metadata: $ownerMetadata), including scoped grants and Stop', ({ flavor, ownerMetadata }) => {
        const session = createSessionFixture({ id: 'edit-session', active: true,
            metadata: { path: '/tmp/notch-choice-parity', host: 'qa', ...(ownerMetadata ? {} : { flavor }) },
            ...(ownerMetadata ? { metadataLayoutVersion: 1, ownerMetadataView: { path: '/tmp/notch-choice-parity', host: 'qa', flavor } } : {}),
            agentState: { requests: { edit: { tool: 'Edit', kind: 'permission',
                arguments: { file_path: '/tmp/notch-choice-parity/file.txt', old_string: 'before', new_string: 'after' },
                createdAt: 950 } } },
        });
        const candidate = buildSessionActivityAttention({ session, nowMs: 1_000 });
        const snapshot = buildDesktopActivityOverlaySnapshot({ source: createOverlaySource({ sessions: [session] }),
            sourceOverview: { candidates: [candidate], counts: { unread: 0, permissionRequired: 1, actionRequired: 0, thinking: 0, totalAttention: 1 } },
            activityPolicy: resolveActivitySurfacePolicy({}), desktopPolicy: createDesktopPolicy(), nowMs: 1_000 });
        const model = buildDesktopActivityOverlayModel({ snapshot, policy: createDesktopPolicy(), sharedActivity: EMPTY_SHARED_ACTIVITY });
        const card = model.expanded.cards?.find(card => card.kind === 'permission_request');
        expect(card?.kind).toBe('permission_request');
        if (card?.kind !== 'permission_request') throw new Error('Missing file edit');
        const actions = resolveDesktopActivityOverlayRequestCardActions(card);
        expect(actions.map(action => action.id)).toEqual(flavor === 'codex'
            ? ['allow', 'always_allow', 'deny', 'stop'] : ['allow', 'allow_all_edits', 'deny', 'stop']);
        expect(actions.find(action => action.id === 'allow')?.data).toMatchObject({ decision: 'approved' });
        expect(actions.find(action => action.id === 'stop')?.data).toMatchObject({ decision: flavor === 'codex' ? 'denied' : 'abort' });
        expect(actions.find(action => action.id === (flavor === 'codex' ? 'always_allow' : 'allow_all_edits'))?.data)
            .toMatchObject(flavor === 'codex' ? { decision: 'approved_for_session' } : { decision: 'approved', mode: 'acceptEdits' });
    });
    it('keeps the admitted pinned ask outside overview slots, with status-only privacy hiding it', () => {
        const session = createSessionFixture({ id: 'pinned', serverId: 'server-1', encryptionMode: 'plain',
            active: true, pendingPermissionRequestCount: 1, pendingRequestObservedAt: 950,
            agentState: { requests: { ask: { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: 950 } } },
        });
        const candidate = buildSessionActivityAttention({ session, nowMs: 1_000 });
        expect(candidate.address).toEqual({ serverId: 'server-1', sessionId: 'pinned' });
        expect(buildDesktopActivityOverlayRequestSnapshots({ candidates: [candidate], resolveCandidatePrivacyMode: () => 'include_preview' })
            .permissionRequests.map(request => request.requestId)).toEqual(['ask']);
        const params = { source: createOverlaySource({ sessions: [session] }),
            sourceOverview: { candidates: [candidate], counts: { unread: 0, permissionRequired: 1, actionRequired: 0, thinking: 0, totalAttention: 1 } },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy(),
            conversation: { serverId: 'server-1', accountId: 'account-server-1', sessionId: session.id, reply: { state: 'none' as const, text: null }, refreshing: false, reachable: true },
            nowMs: 1_000,
        };
        const snapshot = buildDesktopActivityOverlaySnapshot({ ...params, resolveCandidatePrivacyMode: () => 'include_preview' });
        expect(snapshot.sessions).toEqual([expect.objectContaining({ serverId: 'server-1', sessionId: 'pinned' })]);
        expect(snapshot.permissionRequests.map(request => request.requestId)).toEqual(['ask']);
        const hidden = buildDesktopActivityOverlaySnapshot({ ...params,
            conversation: { ...params.conversation, reply: { state: 'hidden', text: null } },
            resolveCandidatePrivacyMode: () => 'status_only' });
        expect(hidden.permissionRequests).toHaveLength(0);
        expect(hidden.conversation?.reply).toEqual({ state: 'hidden', text: null });
    });
    it('keeps reconciled lifecycle facts in a mixed-row desktop snapshot', () => {
        const base = createSessionFixture({ id: 'mixed-desktop', serverId: 'server-1',
            active: true, activeAt: 1_000, presence: 'online', updatedAt: 900,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 950 });
        const row = buildSessionListRenderableFromSession({ ...base, seq: base.seq + 1,
            active: false, activeAt: 100, updatedAt: 100 });
        const candidate = buildSessionActivityAttention({ session: row, nowMs: 1_000,
            presentationSource: createSessionListPresentationSource(row, { baseSession: base, serverId: 'server-1' }) });
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({ sessions: [base] }),
            sourceOverview: { candidates: [candidate],
                counts: { unread: 0, permissionRequired: 1, actionRequired: 0, thinking: 0, totalAttention: 1 } },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy(),
            nowMs: 1_000,
        });
        expect(snapshot.primary).toMatchObject({ sessionId: base.id, active: true, updatedAt: 900 });
    });

    it('projects each row\'s work-status tone and Agent identity for the overlay window', () => {
        const base = createSessionFixture({ id: 'identity-desktop', serverId: 'server-1',
            active: true, activeAt: 1_000, presence: 'online', updatedAt: 900,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 950,
            metadata: { path: '/repo', host: 'host', flavor: 'claude', machineId: 'machine-1' } });
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({ sessions: [base] }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy(),
            nowMs: 1_000,
        });
        expect(snapshot.sessions[0]).toMatchObject({ sessionId: base.id, tone: 'attention', agentId: 'claude', machineId: 'machine-1' });
    });

    it.each(['status_only', 'title_only', 'include_preview'] as const)('applies %s workspace privacy to real-source overlay payloads', (privacyMode) => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                ...createOverlaySource({ sessions: [createSessionFixture({
                    id: 'workspace-privacy',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/PRIVATE-WORKSPACE-SENTINEL',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                })] }),
                serverProfilesById: {
                    'server-1': {
                        id: 'server-1', name: 'Home A', serverUrl: 'https://server-1.example.test',
                        createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual',
                    },
                },
            },
            activityPolicy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: privacyMode }),
            desktopPolicy: createDesktopPolicy(),
            nowMs: 1_000,
        });

        expect(snapshot.primary?.sessionId).toBe('workspace-privacy');
        expect(snapshot.primary?.subtitle).toContain('Home A');
        expect(JSON.stringify(snapshot.sessions).includes('PRIVATE-WORKSPACE-SENTINEL')).toBe(privacyMode === 'include_preview');
    });

    describe('who is asking', () => {
        const askingSession = (overrides: Parameters<typeof createSessionFixture>[0] = {}) => createSessionFixture({
            id: 'asker', serverId: 'server-1', encryptionMode: 'plain', active: true, presence: 'online',
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 950,
            agentState: { requests: { ask: { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: 950 } } },
            metadata: { path: '/Users/tester/happier', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1' },
            ...overrides,
        });
        const buildFor = (
            session: ReturnType<typeof createSessionFixture>,
            machines: Record<string, Readonly<{ id: string; metadata: Readonly<{ displayName?: string; host?: string }> }>>,
            privacyMode?: 'status_only',
        ) => buildDesktopActivityOverlaySnapshot({
            source: {
                ...createOverlaySource({ sessions: [session] }),
                serverProfilesById: { 'server-1': {
                    id: 'server-1', name: 'Home A', serverUrl: 'https://server-1.example.test',
                    createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual',
                } },
            },
            machineDisplaysByServerId: { 'server-1': machines },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy(),
            nowMs: 1_000,
            ...(privacyMode ? { resolveCandidatePrivacyMode: () => privacyMode } : {}),
        });
        const devbox = { 'machine-1': { id: 'machine-1', metadata: { displayName: 'devbox', host: 'devbox.local' } } };

        it('names the project and Machine while it asks, at the default privacy', () => {
            const snapshot = buildFor(askingSession(), devbox);

            expect(snapshot.permissionRequests).toHaveLength(1);
            expect(snapshot.primary?.subtitle).toBe('happier · devbox');
        });

        it('tells two same-named Machines apart', () => {
            const snapshot = buildFor(askingSession(), {
                'machine-1': { id: 'machine-1', metadata: { host: 'box' } },
                'machine-2': { id: 'machine-2', metadata: { host: 'box' } },
            });

            expect(snapshot.primary?.subtitle).toMatch(/^happier · box · machine-1/);
        });

        it('names only the Machine for a Session without a folder', () => {
            const snapshot = buildFor(askingSession({ metadata: {
                path: '/managed/private', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1',
                sessionDirectoryV1: { v: 1, kind: 'managed' },
            } }), devbox);

            expect(snapshot.primary?.subtitle).toBe('devbox');
        });

        it('keeps the Home when it knows neither project nor Machine', () => {
            const snapshot = buildFor(askingSession({ metadata: {
                path: '/managed/private', host: 'tester.local', sessionDirectoryV1: { v: 1, kind: 'managed' },
            } }), {});

            expect(snapshot.primary?.subtitle).toBe('Home A');
        });

        it('leaves a row that is not asking to the privacy preference', () => {
            const snapshot = buildFor(askingSession({ agentState: {} }), devbox);

            expect(snapshot.permissionRequests).toHaveLength(0);
            expect(snapshot.primary?.subtitle).toBe('Home A');
        });

        it('says nothing more when the privacy preference withholds the ask itself', () => {
            const snapshot = buildFor(askingSession(), devbox, 'status_only');

            expect(snapshot.permissionRequests).toHaveLength(0);
            expect(JSON.stringify(snapshot.sessions)).not.toContain('devbox');
            expect(JSON.stringify(snapshot.sessions)).not.toContain('happier');
        });
    });

    it('carries the shared safe structural context independently of locked private content', () => {
        const session = createSessionFixture({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
            id: 'locked-context',
            serverId: 'server-1',
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 950,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
            metadata: {
                path: '/private/PRIVATE-WORKSPACE-SENTINEL',
                host: 'PRIVATE-HOST-SENTINEL',
                summary: { text: 'PRIVATE-TITLE-SENTINEL', updatedAt: 3 },
            },
        });
        const contextLine = 'Home B · Offline · Last updated 18m ago · Developers · Assigned to you · Encrypted access pending';
        const candidate = {
            ...buildSessionActivityAttention({ session, nowMs: 1_000 }),
            context: {
                address: { serverId: 'server-1', sessionId: session.id },
                segments: contextLine.split(' · ').map((label, index) => ({
                    kind: (['home', 'freshness', 'freshness', 'audience', 'responsibility', 'content_availability'] as const)[index]!,
                    label,
                })),
                contextLine,
                accessibilityContext: contextLine,
                workspace: null,
                mayShowDecryptedContent: false,
            },
        };
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({ sessions: [session] }),
            sourceOverview: {
                candidates: [candidate],
                counts: { unread: 0, permissionRequired: 1, actionRequired: 0, thinking: 0, totalAttention: 1 },
            },
            activityPolicy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'status_only' }),
            desktopPolicy: createDesktopPolicy(),
            nowMs: 1_000,
        });

        expect(snapshot.primary?.subtitle).toBe(contextLine);
        expect(JSON.stringify(snapshot.primary)).not.toContain('PRIVATE-');
    });

    it('keeps the activity snapshot focused on the selected desktop activity session', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    createSessionFixture({
                        encryptionMode: 'plain',
                        id: 'permission-without-companion-policy',
                        active: true,
                        presence: 'online',
                        pendingPermissionRequestCount: 1,
                    }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.primary?.sessionId).toBe('permission-without-companion-policy');
        expect(snapshot.state).toBe('content');
    });

    it('keeps active-session overlays focused on active sessions even when auto-show triggers are disabled', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'thinking',
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    active: true,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: 950,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 2 },
                    },
                }),
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'quiet-active',
                    seq: 3,
                    lastViewedSessionSeq: 3,
                    active: true,
                    presence: 'online',
                    metadata: {
                        path: '/Users/tester/project/quiet-active',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet active work', updatedAt: 1 },
                    },
                }),
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'inactive-unread',
                    seq: 10,
                    lastViewedSessionSeq: 1,
                    active: false,
                    presence: 1,
                    metadata: {
                        path: '/Users/tester/project/inactive-unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Inactive unread work', updatedAt: 4 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        const model = buildDesktopActivityOverlayModel({
            snapshot,
            policy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            sharedActivity: EMPTY_SHARED_ACTIVITY,
        });

        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
            'permission',
            'thinking',
            'quiet-active',
        ]);
        expect(model.collapsed.sessionCount).toBeNull();
    });

    it('keeps admitted expanded preview text after the collapsed preview preference retires', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'preview-session',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/preview',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Need your approval', updatedAt: 3 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            desktopPolicy: createDesktopPolicy({}),
            nowMs: 1_000,
        });

        expect(snapshot.sessions[0]).toHaveProperty('previewText', 'Need your approval');
    });

    it('renders an explicit idle state in always-when-enabled mode when no active or attention-bearing sessions qualify', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'quiet-inactive',
                    active: false,
                    presence: 'online',
                    thinking: false,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    pendingCount: 0,
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    metadata: {
                        path: '/Users/tester/project/quiet-inactive',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet recent work', updatedAt: 5 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'always_when_enabled',

            }),
            nowMs: 1_000,
        });

        expect(snapshot.state).toBe('idle');
        expect(snapshot.sessions).toEqual([]);
        expect(snapshot.primary).toBeNull();
        expect(snapshot.defaultTarget).toBe('open-inbox');
    });

    it('does not admit a hydrated Session while canonical ordinary membership lags', () => {
        const visibleSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'visible-session',
            active: true,
            presence: 'online',
            metadata: {
                path: '/Users/tester/project/visible',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Visible work', updatedAt: 3 },
            },
        });
        const detachedSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'detached-session',
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            agentState: {
                requests: {
                    'detached-permission': {
                        tool: 'Bash',
                        arguments: {
                            command: 'git status',
                        },
                        createdAt: 900,
                    },
                },
            },
            metadata: {
                path: '/Users/tester/project/detached',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Detached work', updatedAt: 5 },
            },
        });
        const source = createOverlaySource({
            sessions: [visibleSession, detachedSession],
        });

        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                ...source,
                sessionListRowsByServerId: {
                    'server-1': {
                        [visibleSession.id]: source.sessionListRowsByServerId?.['server-1']?.[visibleSession.id]!,
                    },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-1': [visibleSession.id],
                },
                sessionListIndexByServerId: {
                    'server-1': [
                        {
                            type: 'session',
                            sessionId: visibleSession.id,
                            serverId: 'server-1',
                        },
                    ],
                },
            },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
            'visible-session',
        ]);
        expect(snapshot.permissionRequests).toEqual([]);
    });

    it('does not expose retained request copy or direct answers when selected content availability is unknown', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({ sessions: [createSessionFixture({
                id: 'locked-requests', encryptionMode: 'e2ee', encryptedContentAvailability: undefined,
                active: true, presence: 'online', pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1,
                agentState: { requests: {
                    permission: { tool: 'Bash', arguments: { command: 'private-command' }, createdAt: 100 },
                    question: { tool: 'AskUserQuestion', kind: 'user_action', createdAt: 100,
                        arguments: { questions: [{ question: 'Private question?', options: [{ label: 'Private answer' }], multiSelect: false }] } },
                } },
            })] }),
            activityPolicy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'include_preview' }),
            desktopPolicy: createDesktopPolicy({ visibilityMode: 'active_sessions' }),
            nowMs: 1_000,
        });
        expect(snapshot.primary?.sessionId).toBe('locked-requests');
        expect(snapshot.permissionRequests).toEqual([]);
        expect(snapshot.userQuestions).toEqual([]);
        expect(snapshot.defaultTarget).toContain('locked-requests');
    });

    it('derives permission-request and user-question snapshots for selected overlay sessions', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'session-permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: {
                        requests: {
                            'perm-1': {
                                tool: 'Bash',
                                arguments: {
                                    command: 'npm test',
                                },
                                createdAt: 100,
                            },
                        },
                    },
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Need approval', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    encryptionMode: 'plain',
                    id: 'session-question',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    agentState: {
                        requests: {
                            'question-1': {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: {
                                    questions: [
                                        {
                                            question: 'Which deployment target?',
                                            options: [
                                                { label: 'Production', description: 'Deploy to production' },
                                                { label: 'Staging', description: 'Deploy to staging' },
                                            ],
                                            multiSelect: false,
                                        },
                                    ],
                                },
                                createdAt: 110,
                            },
                        },
                    },
                    metadata: {
                        path: '/Users/tester/project/question',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Question pending', updatedAt: 4 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.state).toBe('content');
        expect(snapshot.primary).toEqual(expect.objectContaining({
            serverId: 'server-1',
            sessionId: 'session-permission',
            attentionState: 'permission_required',
        }));
        expect(snapshot.permissionRequests).toEqual([
            expect.objectContaining({
                serverId: 'server-1',
                sessionId: 'session-permission',
                requestId: 'perm-1',
                kind: 'permission_request',
                openActionIdentifier: 'open-session:session-permission?serverId=server-1',
                allowActionIdentifier: 'session.permission.respond',
                denyActionIdentifier: 'session.permission.respond',
            }),
        ]);
        expect(snapshot.userQuestions).toEqual([
            expect.objectContaining({
                serverId: 'server-1',
                sessionId: 'session-question',
                requestId: 'question-1',
                kind: 'user_question',
                openActionIdentifier: 'open-session:session-question?serverId=server-1',
                questionText: 'Which deployment target?',
                directOptions: [
                    expect.objectContaining({
                        label: 'Production',
                        actionIdentifier: 'session.user_action.answer',
                        answers: [
                            {
                                question: 'Which deployment target?',
                                answer: 'Production',
                            },
                        ],
                    }),
                    expect.objectContaining({
                        label: 'Staging',
                        actionIdentifier: 'session.user_action.answer',
                    }),
                ],
            }),
        ]);
        expect(snapshot.defaultTarget).toBe('open-session:session-permission?serverId=server-1');
    });

    it('preserves canonical permission identity when a newer unread renderable supplies attention', () => {
        const canonicalSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'hidden-global-permission',
            serverId: 'server-1',
            seq: 3,
            lastViewedSessionSeq: 3,
            active: true,
            presence: 'online',
            agentStateVersion: 7,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 900,
            agentState: {
                requests: {
                    'canonical-request-42': {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {
                            command: 'git status --short',
                        },
                        createdAt: 900,
                    },
                },
            },
            metadata: {
                path: '/Users/tester/project/hidden-global-permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                systemSessionV1: {
                    v: 1,
                    key: 'voice_conversation_retired',
                    hidden: true,
                },
            },
        });
        const source = createOverlaySource({
            sessions: [canonicalSession],
        });
        const newerUnreadRenderable = {
            ...source.sessionListRowsByServerId?.['server-1']?.[canonicalSession.id]!,
            seq: 4,
            updatedAt: 950,
            latestReadyEventSeq: 4,
            hasUnreadMessages: true,
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: 900,
            agentStateVersion: 7,
        };

        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                ...source,
                sessionListRowsByServerId: {
                    'server-1': { [canonicalSession.id]: newerUnreadRenderable },
                },
            },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.permissionRequests).toEqual([
            expect.objectContaining({
                requestId: 'canonical-request-42',
                sessionId: canonicalSession.id,
                serverId: 'server-1',
                toolLabel: 'Bash',
                summary: expect.stringContaining('git status --short'),
                allowActionIdentifier: 'session.permission.respond',
                denyActionIdentifier: 'session.permission.respond',
            }),
        ]);
    });

    it('keeps renderable-only request summaries openable without fabricating response actions', () => {
        const canonicalSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'hidden-summary-requests',
            serverId: 'server-1',
            seq: 4,
            lastViewedSessionSeq: 4,
            active: true,
            presence: 'online',
            agentStateVersion: 6,
            agentState: null,
            metadata: {
                path: '/Users/tester/project/hidden-summary-requests',
                host: 'tester.local',
                homeDir: '/Users/tester',
                systemSessionV1: {
                    v: 1,
                    key: 'voice_conversation_retired',
                    hidden: true,
                },
            },
        });
        const source = createOverlaySource({
            sessions: [canonicalSession],
        });

        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                ...source,
                sessionListRowsByServerId: {
                    'server-1': { [canonicalSession.id]: {
                        ...source.sessionListRowsByServerId?.['server-1']?.[canonicalSession.id]!,
                        agentStateVersion: 7,
                        hasPendingPermissionRequests: true,
                        hasPendingUserActionRequests: true,
                        pendingRequestObservedAt: 950,
                    } },
                },
            },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy(),
            nowMs: 1_000,
        });

        expect(snapshot.state).toBe('content');
        expect(snapshot.primary).toMatchObject({
            sessionId: canonicalSession.id,
            serverId: 'server-1',
            attentionState: 'permission_required',
        });
        expect(snapshot.permissionRequests).toEqual([]);
        expect(snapshot.userQuestions).toEqual([]);
    });

    it('retains risk as presentation metadata without narrowing the Session choices', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    createSessionFixture({
                        encryptionMode: 'plain',
                        id: 'session-edit',
                        metadata: { path: '/repo', host: 'qa', flavor: 'claude' },
                        active: true,
                        presence: 'online',
                        pendingPermissionRequestCount: 1,
                        agentState: {
                            requests: {
                                'perm-edit': {
                                    tool: 'Edit',
                                    arguments: {
                                        file_path: 'src/auth/middleware.ts',
                                    },
                                    createdAt: 100,
                                },
                            },
                        },
                    }),
                    createSessionFixture({
                        encryptionMode: 'plain',
                        id: 'session-bash',
                        metadata: { path: '/repo', host: 'qa', flavor: 'claude' },
                        active: true,
                        presence: 'online',
                        pendingPermissionRequestCount: 1,
                        agentState: {
                            requests: {
                                'perm-bash': {
                                    tool: 'Bash',
                                    arguments: {
                                        command: 'git status --short',
                                    },
                                    createdAt: 110,
                                },
                            },
                        },
                    }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });
        const model = buildDesktopActivityOverlayModel({
            snapshot,
            policy: createDesktopPolicy(),
            sharedActivity: EMPTY_SHARED_ACTIVITY,
        });

        expect(snapshot.permissionRequests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                requestId: 'perm-edit',
                risk: 'high',
            }),
            expect.objectContaining({
                requestId: 'perm-bash',
                risk: 'low',
            }),
        ]));

        const cards = model.expanded.cards ?? [];
        const editCard = cards.find((card) => card.id === activityInstanceKey(
            { serverId: 'server-1', sessionId: 'session-edit' },
            JSON.stringify(['permission_request', 'perm-edit']),
        ));
        const bashCard = cards.find((card) => card.id === activityInstanceKey(
            { serverId: 'server-1', sessionId: 'session-bash' },
            JSON.stringify(['permission_request', 'perm-bash']),
        ));

        expect(editCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'high',
            actions: expect.arrayContaining([
                expect.objectContaining({ id: 'allow' }),
                expect.objectContaining({ id: 'allow_all_edits' }),
                expect.objectContaining({ id: 'deny' }),
                expect.objectContaining({ id: 'open:perm-edit' }),
            ]),
        }));
        expect(editCard).not.toEqual(expect.objectContaining({
            actions: expect.arrayContaining([
                expect.objectContaining({ id: 'always_allow' }),
            ]),
        }));
        expect(bashCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'low',
            actions: expect.arrayContaining([
                expect.objectContaining({ id: 'always_allow' }),
                expect.objectContaining({ id: 'allow' }),
            ]),
        }));
    });

    it('derives quota summaries and recent turn completion sessions into the snapshot contract', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    Object.assign(createSessionFixture({
                        encryptionMode: 'plain',
                        id: 'session-ready',
                        active: true,
                        presence: 'online',
                        seq: 5,
                        lastViewedSessionSeq: 5,
                        metadata: {
                            path: '/Users/tester/project/ready',
                            host: 'tester.local',
                            homeDir: '/Users/tester',
                            summary: { text: 'Ready session', updatedAt: 5 },
                        },
                    }), {
                        lastTurnCompletedAt: 990,
                    }),
                ],
                quotaSummaries: [
                    {
                        key: 'claude:default',
                        serviceGroupKey: 'happier.agent.claude/anthropic',
                        accountLabel: 'Claude',
                        accountEmail: null,
                        accountId: 'default',
                        recoveryCredits: null,
                        service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
                        legacyServiceId: 'anthropic',
                        serviceLabel: 'Anthropic',
                        profileId: 'default',
                        profileLabel: 'Claude',
                        planLabel: 'Pro',
                        fetchedAt: 900,
                        primaryMeter: {
                            meterId: 'requests',
                            label: 'Requests',
                            remainingPct: 12,
                            utilizationPct: 88,
                            status: 'estimated',
                            resetsAt: null,
                        },
                        meters: [
                            {
                                meterId: 'requests',
                                label: 'Requests',
                                remainingPct: 12,
                                utilizationPct: 88,
                                status: 'estimated',
                                resetsAt: null,
                            },
                        ],
                    },
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.quotaSummaries).toEqual([
            expect.objectContaining({
                id: 'claude:default',
                title: 'Claude',
                summary: expect.stringContaining('12%'),
            }),
        ]);
        expect(snapshot.completionStates).toEqual([
            expect.objectContaining({
                sessionId: 'session-ready',
                serverId: 'server-1',
                title: 'Ready session',
                summary: expect.any(String),
                openActionIdentifier: 'open-session:session-ready?serverId=server-1',
                variant: 'turn_complete',
                autoDismissMs: 15000,
                sticky: false,
            }),
        ]);
    });

    it('does not derive completion cards from stale completion timestamps or generic pending state', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    Object.assign(createSessionFixture({
                        encryptionMode: 'plain',
                        id: 'stale-ready',
                        active: true,
                        presence: 'online',
                        pendingCount: 1,
                        seq: 5,
                        lastViewedSessionSeq: 5,
                        metadata: {
                            path: '/Users/tester/project/stale',
                            host: 'tester.local',
                            homeDir: '/Users/tester',
                            summary: { text: 'Stale ready', updatedAt: 5 },
                        },
                    }), {
                        lastTurnCompletedAt: 1_000,
                    }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 31_001,
        });

        expect(snapshot.completionStates).toEqual([]);
    });

});
