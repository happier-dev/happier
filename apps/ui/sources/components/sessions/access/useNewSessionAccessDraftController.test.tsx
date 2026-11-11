import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { t } from '@/text';
import { reconcileSessionAccessDraftForHome } from '@/sync/domains/session/access/sessionAccessDraftReconciliation';

import { useNewSessionAccessDraftController } from './useNewSessionAccessDraftController';
import { useNewSessionAccessDraft, type NewSessionAccessDraftState } from './useNewSessionAccessDraft';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { SessionAccessCandidateRowModel } from './sessionAccessEditorTypes';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const shareCandidateAvailability = vi.hoisted(() => ({ value: false }));

afterEach(() => {
    creationDecisionNetworkMode.enabled = false;
    shareCandidateAvailability.value = false;
    resetRuntimeFetch();
    vi.restoreAllMocks();
});

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Directory sources are the network boundary; the draft owner below stays real.
const runTeamActionMock = vi.hoisted(() => vi.fn(
    async (_request: Readonly<{ input: Record<string, unknown> }>) => ({
        kind: 'failed' as const,
        failure: { kind: 'unreachable' as const, retryable: true, code: null },
    }),
));
const creationDecisionNetworkMode = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/sync/api/session/sessionAccessApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionAccessApi')>();
    return {
        ...actual,
        resolveSessionAccessCreationDecision: (options: Parameters<typeof actual.resolveSessionAccessCreationDecision>[0]) => creationDecisionNetworkMode.enabled
            ? actual.resolveSessionAccessCreationDecision(options)
            : Promise.resolve({
                v: 1 as const,
                teamId: options.teamId,
                teamName: options.teamId,
                requiredByPolicy: options.teamId === 'team-required',
                defaultGrant: options.teamId === 'team-default' ? { accessLevel: 'edit' as const, canApprovePermissions: false } : null,
                externalSharingPolicy: options.teamId === 'team-required' ? 'team_admins_only' as const : 'allowed' as const,
            }),
    };
});
vi.mock('@/sync/ops/teams/teamActionClient', () => ({
    runTeamAction: runTeamActionMock,
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: (serverId: string | null) => serverId
        ? { kind: 'bound', scope: { serverId, accountId: 'creator' } }
        : { kind: 'unbound' },
}));
vi.mock('@/hooks/session/useSessionCollaborationAvailability', () => ({
    useSessionCollaborationAvailability: () => 'available',
}));
vi.mock('./sessionShareCandidateAvailability', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sessionShareCandidateAvailability')>();
    return {
        ...actual,
        useHasSessionShareCandidates: () => shareCandidateAvailability.value,
    };
});
// This suite exercises the real draft/currentness and editor-controller
// owners. Keep their presentation leaf inert so unrelated Markdown/plugin
// renderer graphs are not part of this owner-level test.
vi.mock('./SessionAccessEditor', () => ({ SessionAccessEditor: 'SessionAccessEditor' }));

const scope = { serverId: 'home-one', accountId: 'creator' };

describe('reconcileSessionAccessDraftForHome', () => {
    const access: SessionInitialAccessDraftV1 = {
        grants: [{ subject: { kind: 'account', accountId: 'alice' }, accessLevel: 'view', canApprovePermissions: false }],
    };

    it('keeps the draft while the target Home is unchanged', () => {
        expect(reconcileSessionAccessDraftForHome({ access, previousServerId: 'home-one', nextServerId: 'home-one' }))
            .toEqual({ access, removedCount: 0, changed: false });
    });

    it('drops Home-local principals the new Home cannot address and reports the change', () => {
        expect(reconcileSessionAccessDraftForHome({ access, previousServerId: 'home-one', nextServerId: 'home-two' }))
            .toEqual({ access: null, removedCount: 1, changed: true });
    });
});

type Controller = ReturnType<typeof useNewSessionAccessDraftController>;

function Probe(props: Readonly<{
    initial: SessionInitialAccessDraftV1 | null;
    initialPrimaryTeamId?: string | null;
    homeReconciled?: boolean;
    availability: SessionCollaborationAvailability;
    /** Mirrors an open editor presentation; the composer's closed chip does not demand candidates. */
    demanded?: boolean;
    scope?: typeof scope;
    onReady: (controller: Controller, access: SessionInitialAccessDraftV1 | null, primaryTeamId: string | null) => void;
}>) {
    const [access, setAccess] = React.useState(props.initial);
    const [primaryTeamId, setPrimaryTeamId] = React.useState<string | null>(props.initialPrimaryTeamId ?? null);
    const controller = useNewSessionAccessDraftController({
        scope: props.scope ?? scope, access, primaryTeamId, availability: props.availability,
        homeReconciled: props.homeReconciled === true,
        demanded: props.demanded !== false,
        onChange: setAccess, onPrimaryTeamIdChange: setPrimaryTeamId,
    });
    props.onReady(controller, access, primaryTeamId);
    return null;
}

describe('useNewSessionAccessDraftController', () => {
    it('resolves restored off-page selected identities only when demanded and rejects late Home results', async () => {
        const first = await upsertServerProfile({ name: 'Draft first', serverUrl: 'https://draft-first.example.test' });
        const second = await upsertServerProfile({ name: 'Draft second', serverUrl: 'https://draft-second.example.test' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'creator' })).toString('base64url')}.signature`,
        });
        const requested: Array<{ origin: string; body: unknown }> = [];
        let releaseFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
        setRuntimeFetch(async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/auth/ping') return new Response('{}');
            if (parsed.pathname === '/v1/session-access/principals/resolve') {
                requested.push({ origin: parsed.origin, body: JSON.parse(String(init?.body)) });
                if (parsed.origin === 'https://draft-first.example.test') return firstResponse;
                return new Response(JSON.stringify({ v: 1, principals: [
                    { kind: 'account', accountId: 'off-page-alice', username: 'second-alice', firstName: 'Alice', lastName: 'Second', avatarUrl: null },
                    { kind: 'account', accountId: 'off-page-bob', username: 'second-bob', firstName: 'Bob', lastName: 'Second', avatarUrl: null },
                ] }));
            }
            return new Response('{}', { status: 404 });
        });
        const initial: SessionInitialAccessDraftV1 = { grants: [
            { subject: { kind: 'account', accountId: 'off-page-alice' }, accessLevel: 'edit', canApprovePermissions: false },
            { subject: { kind: 'account', accountId: 'off-page-bob' }, accessLevel: 'admin', canApprovePermissions: true },
        ] };
        let latest!: Controller;
        const element = (serverId: string, demanded: boolean) => <Probe initial={initial}
            scope={{ serverId, accountId: 'creator' }} demanded={demanded} availability="available"
            onReady={(controller) => { latest = controller; }} />;
        const screen = await renderScreen(element(first.id, false));
        expect(requested).toEqual([]);
        await screen.update(element(first.id, true));
        await vi.waitFor(() => expect(requested).toHaveLength(1));
        await screen.update(element(second.id, true));
        await vi.waitFor(() => expect(latest.model.grants.map((row) => row.principal.displayName)).toEqual(['Alice Second', 'Bob Second']));
        expect(latest.model.grants.map((row) => row.principal.accessibilityLabel)).toEqual([
            'Alice Second, @second-alice', 'Bob Second, @second-bob',
        ]);
        expect(latest.query.read()).toBe('');
        expect(requested[1]).toEqual({ origin: 'https://draft-second.example.test', body: {
            v: 1, subjects: initial.grants.map((grant) => grant.subject),
        } });
        await act(async () => { releaseFirst(new Response(JSON.stringify({ v: 1, principals: [
            { kind: 'account', accountId: 'off-page-alice', username: 'wrong-home', firstName: 'Wrong', lastName: 'Home', avatarUrl: null },
        ] }))); });
        expect(latest.model.grants.map((row) => row.principal.displayName)).toEqual(['Alice Second', 'Bob Second']);
    });

    it('keeps restored selected Accounts distinguishable without a directory search', async () => {
        let latest: Controller | null = null;
        await renderScreen(<Probe initial={{ grants: [
            { subject: { kind: 'account', accountId: 'off-page-alice' }, accessLevel: 'edit', canApprovePermissions: false },
            { subject: { kind: 'account', accountId: 'off-page-bob' }, accessLevel: 'admin', canApprovePermissions: true },
        ] }} availability="available" onReady={(controller) => { latest = controller; }} />);

        // Selected recipients must remain identifiable even when they are not in
        // the currently loaded search page (or the directory is unavailable).
        expect(new Set(latest!.model.grants.map((row) => row.principal.displayName)).size).toBe(2);
        expect(new Set(latest!.model.grants.map((row) => row.principal.accessibilityLabel)).size).toBe(2);
        expect(latest!.query.read()).toBe('');
        expect(latest!.model.grants.map((row) => row.grant)).toEqual([
            { kind: 'account', accountId: 'off-page-alice' },
            { kind: 'account', accountId: 'off-page-bob' },
        ]);
    });

    it('surfaces a Home-change reconciliation instead of silently dropping access choices', async () => {
        let latest: Controller | null = null;
        await renderScreen(<Probe initial={null} availability="available" homeReconciled
            onReady={(controller) => { latest = controller; }} />);

        expect(latest!.model.notice).toMatchObject({
            reason: { code: 'session_access_home_reconciled' },
        });
    });

    it('edits only the synchronized creation draft and removes a draft row without acknowledgement', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'acme', name: 'Acme',
                policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
            }], nextCursor: null },
        } as never);
        let latest: Controller | null = null;
        let draft: SessionInitialAccessDraftV1 | null = null;
        // Read through a typed accessor so the assertions keep the draft's real
        // union instead of the `null` its initializer narrows to.
        const readDraft = (): SessionInitialAccessDraftV1 | null => draft;
        await renderScreen(<Probe initial={null} availability="available" onReady={(controller, access) => { latest = controller; draft = access; }} />);

        await act(async () => { latest!.actions.addPrincipal({ kind: 'account', accountId: 'alice' }); });
        expect(draft).toEqual({
            grants: [{ subject: { kind: 'account', accountId: 'alice' }, accessLevel: 'view', canApprovePermissions: false }],
        });
        expect(latest!.model.grants).toHaveLength(1);
        expect(latest!.model.accessMode).toBe('editable');

        await vi.waitFor(() => expect(latest!.model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'acme' }),
        ])));
        await act(async () => { latest!.actions.setContext('acme'); });
        expect(latest!.model.context?.primaryTeamId).toBe('acme');

        await act(async () => { latest!.actions.setAccessLevel({ kind: 'account', accountId: 'alice' }, 'admin'); });
        expect(readDraft()?.grants[0]?.accessLevel).toBe('admin');

        await act(async () => { latest!.actions.setPermissionDelegation({ kind: 'account', accountId: 'alice' }, true); });
        expect(readDraft()?.grants[0]?.canApprovePermissions).toBe(true);

        // Selecting View clears delegation through the same draft projection.
        await act(async () => { latest!.actions.setAccessLevel({ kind: 'account', accountId: 'alice' }, 'view'); });
        expect(readDraft()?.grants[0]).toEqual({
            subject: { kind: 'account', accountId: 'alice' }, accessLevel: 'view', canApprovePermissions: false,
        });

        // A draft row is local, so removal is immediate rather than two-step.
        await act(async () => { latest!.actions.requestRemove({ kind: 'account', accountId: 'alice' }); });
        expect(draft).toBeNull();
        expect(latest!.model.grants).toHaveLength(0);
    });

    it('refuses to author access on a Home that does not share Sessions and explains why', async () => {
        let latest: Controller | null = null;
        let draft: SessionInitialAccessDraftV1 | null = null;
        const seeded: SessionInitialAccessDraftV1 = {
            grants: [{ subject: { kind: 'team', teamId: 'acme' }, accessLevel: 'view', canApprovePermissions: false }],
        };
        await renderScreen(<Probe initial={seeded} availability="unavailable" onReady={(controller, access) => { latest = controller; draft = access; }} />);

        expect(latest!.model.accessMode).toBe('read_only');
        expect(latest!.model.notice).toMatchObject({ message: t('session.collaboration.accessUnavailableReason'), action: 'clear_access' });
        expect(latest!.model.directory.sections).toHaveLength(0);

        await act(async () => { latest!.actions.addPrincipal({ kind: 'account', accountId: 'alice' }); });
        expect(draft).toEqual(seeded);

        await act(async () => { latest!.actions.clearAccess(); });
        expect(draft).toBeNull();
        expect(latest!.model.context?.primaryTeamId).toBeNull();
    });

    it('discovers Groups from member Teams that are not already present in the access draft', async () => {
        runTeamActionMock
            .mockResolvedValueOnce({
                kind: 'succeeded', value: { items: [{
                    id: 'team-new', name: 'New Team',
                    policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
                }], nextCursor: null },
            } as never)
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: { items: [{ id: 'group-new', teamId: 'team-new', name: 'New Group' }], nextCursor: null },
            } as never);
        let latest: Controller | null = null;
        await renderScreen(<Probe
            initial={null}
            availability="available"
            onReady={(controller) => { latest = controller; }}
        />);
        const groups = latest!.model.directory.sections.find((section) => section.kind === 'group');
        expect(groups).toBeDefined();
        let candidates: readonly SessionAccessCandidateRowModel[] = [];
        await act(async () => {
            candidates = await groups!.resolveCandidates!('', new AbortController().signal);
        });
        expect(candidates.map((candidate) => candidate.principal.ref)).toEqual([
            { kind: 'group', teamId: 'team-new', groupId: 'group-new' },
        ]);
    });

    it('offers an ungranted Team and applies its required floor only after reviewed confirmation', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-required', name: 'Required Team',
                policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'team_admins_only' },
            }], nextCursor: null },
        } as never);
        let latest: Controller | null = null;
        let draft: SessionInitialAccessDraftV1 | null = null;
        await renderScreen(<Probe initial={null} availability="available" onReady={(controller, access) => {
            latest = controller;
            draft = access;
        }} />);

        await vi.waitFor(() => expect(latest!.model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-required', label: 'Required Team' }),
        ])));
        await act(async () => { latest!.actions.setContext('team-required'); });
        expect(latest!.model.context?.confirmation?.consequences).toHaveLength(2);
        expect(latest!.model.context?.primaryTeamId).toBeNull();
        expect(draft).toBeNull();

        await act(async () => { latest!.actions.confirmContext(); });
        expect(latest!.model.context?.primaryTeamId).toBe('team-required');
        expect(draft).toEqual({ grants: [{
            subject: { kind: 'team', teamId: 'team-required' },
            accessLevel: 'edit',
            canApprovePermissions: false,
        }] });
    });

    it('derives the required Team floor for a restored context, not only an in-editor change', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-required', name: 'Required Team',
                policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'allowed' },
            }], nextCursor: null },
        } as never);
        let latest: Controller | null = null;
        let draft: SessionInitialAccessDraftV1 | null = null;
        // A restored draft carries the Team context without ever passing through
        // the in-editor context change that used to be the only seed.
        await renderScreen(<Probe initial={null} initialPrimaryTeamId="team-required" availability="available"
            onReady={(controller, access) => { latest = controller; draft = access; }} />);

        await vi.waitFor(() => expect(latest!.model.grants).toHaveLength(1));
        expect(draft).toEqual({ grants: [{
            subject: { kind: 'team', teamId: 'team-required' }, accessLevel: 'edit', canApprovePermissions: false,
        }] });
        expect(latest!.model.grants[0]).toMatchObject({
            requiredByTeamPolicy: true, removal: { kind: 'blocked' },
        });
    });

    it('raises a Team-credential visibility grant to the required Edit floor instead of locking View', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-required', name: 'Required Team',
                policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'allowed' },
            }], nextCursor: null },
        } as never);
        const credentialSeeded: SessionInitialAccessDraftV1 = { grants: [{
            subject: { kind: 'team', teamId: 'team-required' }, accessLevel: 'view', canApprovePermissions: false,
        }] };
        let latest: Controller | null = null;
        let draft: SessionInitialAccessDraftV1 | null = credentialSeeded;
        await renderScreen(<Probe initial={credentialSeeded} initialPrimaryTeamId="team-required" availability="available"
            onReady={(controller, access) => { latest = controller; draft = access; }} />);

        await vi.waitFor(() => expect(draft?.grants[0]?.accessLevel).toBe('edit'));
        expect(latest!.model.grants[0]).toMatchObject({ requiredByTeamPolicy: true });
        expect(latest!.model.grants[0]?.level.value).toBe('edit');
    });

    it('does not revive a removed team_default row when the same draft is restored', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-default', name: 'Default Team',
                policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed' },
            }], nextCursor: null },
        } as never);
        let latest: Controller | null = null;
        let draft: SessionInitialAccessDraftV1 | null = null;
        await renderScreen(<Probe initial={null} initialPrimaryTeamId="team-default" availability="available"
            onReady={(controller, access) => { latest = controller; draft = access; }} />);

        await vi.waitFor(() => expect(latest!.model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-default' }),
        ])));
        expect(draft).toBeNull();
        expect(latest!.model.grants).toHaveLength(0);
    });

    it('proposes Edit access for a team_default context but preserves an explicit private override', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-default', name: 'Default Team',
                policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed' },
            }], nextCursor: null },
        } as never);
        let latest: Controller | null = null;
        let draft: SessionInitialAccessDraftV1 | null = null;
        let primaryTeamId: string | null = null;
        await renderScreen(<Probe initial={null} availability="available" onReady={(controller, access, teamId) => {
            latest = controller;
            draft = access;
            primaryTeamId = teamId;
        }} />);

        await vi.waitFor(() => expect(latest!.model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-default', label: 'Default Team' }),
        ])));
        await act(async () => { latest!.actions.setContext('team-default'); });

        expect(primaryTeamId).toBe('team-default');
        expect(draft).toEqual({ grants: [{
            subject: { kind: 'team', teamId: 'team-default' },
            accessLevel: 'edit',
            canApprovePermissions: false,
        }] });
        expect(latest!.model.grants[0]?.removal.kind).toBe('allowed');
        expect(latest!.placementPending).toBe(false);

        await act(async () => { latest!.actions.requestRemove({ kind: 'team', teamId: 'team-default' }); });
        expect(draft).toBeNull();
        expect(primaryTeamId).toBe('team-default');
        expect(latest!.model.context?.primaryTeamId).toBe('team-default');
        expect(latest!.placementPending).toBe(true);
    });

    it('keeps Team context choices on the canonical Team cursor as more candidates load', async () => {
        runTeamActionMock
            .mockResolvedValueOnce({
                kind: 'succeeded', value: { items: [{
                    id: 'team-first', name: 'First Team',
                    policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
                }], nextCursor: 'team-page-two' },
            } as never)
            .mockResolvedValueOnce({
                kind: 'succeeded', value: { items: [{
                    id: 'team-second', name: 'Second Team',
                    policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
                }], nextCursor: null },
            } as never);
        let latest: Controller | null = null;
        await renderScreen(<Probe initial={null} availability="available" onReady={(controller) => { latest = controller; }} />);
        await vi.waitFor(() => expect(latest!.model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-first' }),
        ])));

        await act(async () => { latest!.actions.loadMore('team'); });
        await vi.waitFor(() => expect(latest!.model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-second' }),
        ])));
        expect(runTeamActionMock.mock.calls.at(-1)?.[0].input).toMatchObject({ cursor: 'team-page-two' });
    });

    it('surfaces a blocked draft choice instead of leaving its explanation control inert', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-required', name: 'Required Team',
                policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'allowed' },
            }], nextCursor: null },
        } as never);
        const seeded: SessionInitialAccessDraftV1 = { grants: [{
            subject: { kind: 'team', teamId: 'team-required' }, accessLevel: 'edit', canApprovePermissions: false,
        }] };
        let latest: Controller | null = null;
        await renderScreen(<Probe initial={seeded} initialPrimaryTeamId="team-required" availability="available"
            onReady={(controller) => { latest = controller; }} />);
        await vi.waitFor(() => expect(latest!.model.context?.options[0]?.blockedReason).toBeDefined());

        const reason = latest!.model.context!.options[0]!.blockedReason!;
        act(() => { latest!.actions.explain(reason); });

        expect(latest!.model.notice).toMatchObject({ message: reason.message, reason });
    });
});

function AccessDraftProbe(props: Readonly<{
    serverId: string;
    sourceRevision: number;
    sourceAccess: SessionInitialAccessDraftV1 | null;
    sourcePrimaryTeamId: string | null;
    sourceAccessConflict?: boolean;
    sourcePrimaryTeamConflict?: boolean;
    /** Mounts the composer popover exactly as the chip host does when it opens. */
    popoverOpen?: boolean;
    onReady: (state: NewSessionAccessDraftState) => void;
}>) {
    const state = useNewSessionAccessDraft({
        targetServerId: props.serverId,
        initialAccess: props.sourceAccess,
        initialPrimaryTeamId: props.sourcePrimaryTeamId,
        sourceRevision: props.sourceRevision,
        sourceAccessConflict: props.sourceAccessConflict ?? false,
        sourcePrimaryTeamConflict: props.sourcePrimaryTeamConflict ?? false,
    });
    props.onReady(state);
    const popoverContent = props.popoverOpen ? state.chip?.popoverContent : null;
    return typeof popoverContent === 'function'
        ? <>{popoverContent({ requestClose: () => {}, maxHeight: 420 })}</>
        : popoverContent ?? null;
}

function accessDraftEditor(state: NewSessionAccessDraftState, requestClose: () => void = () => {}) {
    const content = state.chip?.popoverContent;
    // The popover is supplied in the host's render form so Escape reaches the editor.
    if (typeof content !== 'function') throw new Error('expected the New Session access popover render form');
    const element = content({ requestClose, maxHeight: 420 }) as React.ReactElement<{
        actions: ReturnType<typeof useNewSessionAccessDraftController>['actions'];
        model: ReturnType<typeof useNewSessionAccessDraftController>['model'];
        onRequestClose?: () => void;
    }> | undefined;
    if (!element) throw new Error('expected mounted New Session access editor');
    return element.props;
}

function accessDraftActions(state: NewSessionAccessDraftState) {
    return accessDraftEditor(state).actions;
}

describe('useNewSessionAccessDraft repository currentness', () => {
    const alice: SessionInitialAccessDraftV1 = { grants: [{
        subject: { kind: 'account', accountId: 'alice' }, accessLevel: 'view', canApprovePermissions: false,
    }] };
    const bob: SessionInitialAccessDraftV1 = { grants: [{
        subject: { kind: 'account', accountId: 'bob' }, accessLevel: 'edit', canApprovePermissions: false,
    }] };

    it('only exposes Private sharing when the Account has a candidate, while retaining authored recovery', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={null} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        expect(latest!.chip).toBeNull();

        shareCandidateAvailability.value = true;
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={null} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);
        expect(latest!.chip).not.toBeNull();

        expect(latest!.chip?.pending).toBe(false);

        shareCandidateAvailability.value = false;
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);
        expect(latest!.chip).not.toBeNull();
        expect(latest!.chip?.pending).toBe(true);
    });

    it('adopts a newer synchronized access/team choice and exposes that same snapshot to the editor', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId="team-old" onReady={(state) => { latest = state; }} />);

        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={bob} sourcePrimaryTeamId="team-synced" onReady={(state) => { latest = state; }} />);

        expect(latest).toMatchObject({ access: bob, primaryTeamId: 'team-synced' });
    });

    it('does not overwrite a newer device edit when an unrelated repository revision arrives', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newer' });
        });
        const locallyEdited = latest!.access;

        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        expect(latest!.access).toEqual(locallyEdited);
        expect(latest!.access?.grants.map((grant) => grant.subject)).toContainEqual({
            kind: 'account', accountId: 'local-newer',
        });
    });

    it('stops treating a field as locally newer when the user returns it to the observed source value', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newer' });
        });
        await act(async () => {
            accessDraftActions(latest!).requestRemove({ kind: 'account', accountId: 'local-newer' });
        });
        expect(latest!.access).toEqual(alice);

        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={bob} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        expect(latest!.access).toEqual(bob);
    });

    it('tracks Team-context currentness independently from access currentness', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-local', name: 'Local Team',
                policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
            }], nextCursor: null },
        } as never);
        let latest: NewSessionAccessDraftState | null = null;
        // Team candidates are picker detail, so this case drives the open
        // presentation the person picks a context in.
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1} popoverOpen
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);
        await vi.waitFor(() => expect(accessDraftEditor(latest!).model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-local' }),
        ])));
        await act(async () => { accessDraftActions(latest!).setContext('team-local'); });
        expect(latest!.primaryTeamId).toBe('team-local');

        // An unrelated repository revision still carries the previous Team
        // context. It must not erase this newer device edit.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2} popoverOpen
            sourceAccess={bob} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);
        expect(latest!.access).toEqual(bob);
        expect(latest!.primaryTeamId).toBe('team-local');

        // Once its exact echo is observed, a later Use-synced choice may replace it.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={3} popoverOpen
            sourceAccess={bob} sourcePrimaryTeamId="team-local" onReady={(state) => { latest = state; }} />);
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={4} popoverOpen
            sourceAccess={bob} sourcePrimaryTeamId="team-synced" onReady={(state) => { latest = state; }} />);
        expect(latest!.primaryTeamId).toBe('team-synced');
    });

    it('does not let a stale Use-synced resolution overwrite a newer access edit on this device', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newer' });
        });
        const persistedFirst = latest!.access;
        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newest' });
        });
        const deviceEdited = latest!.access;
        expect(deviceEdited).not.toEqual(persistedFirst);

        // The repository persisted the first edit and flagged a same-field
        // conflict. The editor observes it without losing the newer device edit.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={persistedFirst} sourcePrimaryTeamId={null} sourceAccessConflict
            onReady={(state) => { latest = state; }} />);
        expect(latest!.access).toEqual(deviceEdited);

        // Resolving the older conflict to its synchronized value must not
        // overwrite the edit made after that conflict snapshot was shown.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={3}
            sourceAccess={bob} sourcePrimaryTeamId={null}
            onReady={(state) => { latest = state; }} />);
        expect(latest!.access).toEqual(deviceEdited);
    });

    it('preserves a newer device edit when Keep-device resolves without changing the field value', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newer' });
        });
        const persistedFirst = latest!.access;
        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newest' });
        });
        const deviceEdited = latest!.access;

        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={persistedFirst} sourcePrimaryTeamId={null} sourceAccessConflict
            onReady={(state) => { latest = state; }} />);
        expect(latest!.access).toEqual(deviceEdited);

        // Keep-device re-mints the persisted value without changing it, so the
        // newer unpersisted device edit must survive instead of being replaced
        // by the older persisted echo.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={3}
            sourceAccess={persistedFirst} sourcePrimaryTeamId={null}
            onReady={(state) => { latest = state; }} />);
        expect(latest!.access).toEqual(deviceEdited);
    });

    it('does not let a stale Use-synced resolution overwrite a newer Team context on this device', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        await act(async () => { latest!.applyTeamCredentialPolicy('team-local', false); });
        await act(async () => { latest!.applyTeamCredentialPolicy('team-newer', false); });
        expect(latest!.primaryTeamId).toBe('team-newer');

        // The repository persisted the first context choice and flagged its
        // conflict; the newer device choice is preserved.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={alice} sourcePrimaryTeamId="team-local" sourcePrimaryTeamConflict
            onReady={(state) => { latest = state; }} />);
        expect(latest!.primaryTeamId).toBe('team-newer');
        expect(latest!.access).toEqual(alice);

        // The older conflict can be resolved, but it cannot replace the
        // subsequently selected context still held by this mounted editor.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={3}
            sourceAccess={alice} sourcePrimaryTeamId="team-synced"
            onReady={(state) => { latest = state; }} />);
        expect(latest!.primaryTeamId).toBe('team-newer');
        expect(latest!.access).toEqual(alice);
    });

    it('adds Team visibility for a Team credential without reducing an explicit stronger grant', async () => {
        const acmeAdmin: SessionInitialAccessDraftV1 = { grants: [{
            subject: { kind: 'team', teamId: 'acme' }, accessLevel: 'admin', canApprovePermissions: true,
        }] };
        let latest: NewSessionAccessDraftState | null = null;
        await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={acmeAdmin} sourcePrimaryTeamId="acme" onReady={(state) => { latest = state; }} />);

        // The credential only requires that the Team can see the Session. It is
        // not a level decision, so it must not silently reduce the audience the
        // creator already chose (and that a required Team policy may lock).
        await act(async () => { latest!.applyTeamCredentialPolicy('acme', true); });

        expect(latest!.primaryTeamId).toBe('acme');
        expect(latest!.access).toEqual(acmeAdmin);
    });

    it('hands the draft editor the popover host real close instead of a no-op', async () => {
        const requestClose = vi.fn();
        let latest: NewSessionAccessDraftState | null = null;
        await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        accessDraftEditor(latest!, requestClose).onRequestClose?.();
        expect(requestClose).toHaveBeenCalledTimes(1);
    });

    it('keeps edits made in the composer popover editor across close and reopen', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const probe = (popoverOpen: boolean) => (
            <AccessDraftProbe serverId="home-one" sourceRevision={1} sourceAccess={alice} sourcePrimaryTeamId={null}
                popoverOpen={popoverOpen} onReady={(state) => { latest = state; }} />
        );
        const screen = await renderScreen(probe(true));
        // One presentation on every layout: the chip opens nothing else.
        expect(latest!.chip!.onOpen).toBeUndefined();
        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'popover-added' });
        });
        await screen.update(probe(false));
        await screen.update(probe(true));
        expect(latest!.access?.grants.map((grant) => grant.subject)).toContainEqual({
            kind: 'account', accountId: 'popover-added',
        });
    });

    it('adds the safe default Team visibility grant when the Team has none yet', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        await act(async () => { latest!.applyTeamCredentialPolicy('acme', true); });

        expect(latest!.primaryTeamId).toBe('acme');
        expect(latest!.access?.grants).toEqual([
            ...alice.grants,
            { subject: { kind: 'team', teamId: 'acme' }, accessLevel: 'view', canApprovePermissions: false },
        ]);
    });

    it('keeps a newer access edit while adopting an unrelated synchronized Team context', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);

        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newer' });
        });
        const deviceEdited = latest!.access;

        // Only the Team context changed on the repository; the unrelated
        // access edit must survive while the context is adopted.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={alice} sourcePrimaryTeamId="team-synced"
            onReady={(state) => { latest = state; }} />);
        expect(latest!.access).toEqual(deviceEdited);
        expect(latest!.primaryTeamId).toBe('team-synced');
    });

    it('accepts its persisted echo, then adopts a later Use-synced result without reviving another Home', async () => {
        let latest: NewSessionAccessDraftState | null = null;
        const screen = await renderScreen(<AccessDraftProbe serverId="home-one" sourceRevision={1}
            sourceAccess={alice} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);
        await act(async () => {
            accessDraftActions(latest!).addPrincipal({ kind: 'account', accountId: 'local-newer' });
        });
        const locallyEdited = latest!.access;

        // The synchronized repository acknowledges this hook's exact local value.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={2}
            sourceAccess={locallyEdited} sourcePrimaryTeamId={null} onReady={(state) => { latest = state; }} />);
        // A later conflict resolution chooses the synchronized value.
        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={3}
            sourceAccess={bob} sourcePrimaryTeamId="team-synced" onReady={(state) => { latest = state; }} />);
        expect(latest).toMatchObject({ access: bob, primaryTeamId: 'team-synced' });

        await screen.update(<AccessDraftProbe serverId="home-two" sourceRevision={3}
            sourceAccess={bob} sourcePrimaryTeamId="team-synced" onReady={(state) => { latest = state; }} />);
        expect(latest).toMatchObject({ access: null, primaryTeamId: null });

        await screen.update(<AccessDraftProbe serverId="home-one" sourceRevision={3}
            sourceAccess={bob} sourcePrimaryTeamId="team-synced" onReady={(state) => { latest = state; }} />);
        expect(latest).toMatchObject({ access: null, primaryTeamId: null });
    });

    it('reaches the Home directory only once an editor presentation is open', async () => {
        runTeamActionMock.mockClear();
        shareCandidateAvailability.value = true;
        let latest: NewSessionAccessDraftState | null = null;
        const probe = (popoverOpen: boolean) => (
            <AccessDraftProbe serverId="home-one" sourceRevision={1} sourceAccess={null}
                sourcePrimaryTeamId={null} popoverOpen={popoverOpen}
                onReady={(state) => { latest = state; }} />
        );
        const screen = await renderScreen(probe(false));
        await act(async () => {});

        // The collapsed chip consumes only the candidate summary fact. It must
        // not spend a detailed access-directory page on a picker nobody opened.
        expect(latest!.chip).not.toBeNull();
        expect(runTeamActionMock).not.toHaveBeenCalled();

        await screen.update(probe(true));
        await vi.waitFor(() => expect(runTeamActionMock).toHaveBeenCalled());
        const teamPageCalls = () => runTeamActionMock.mock.calls
            .filter(([request]) => (request as unknown as { actionId?: string }).actionId === 'teams.list').length;
        expect(teamPageCalls()).toBe(1);

        // Closing releases the demand without discarding the acquired page, and
        // reopening does not buy a second one.
        await screen.update(probe(false));
        await act(async () => {});
        await screen.update(probe(true));
        await act(async () => {});
        expect(teamPageCalls()).toBe(1);
    });

    it('still resolves the create-time Team policy for a draft that already names a context', async () => {
        // The required-grant floor a named Team imposes is carried into
        // creation whether or not a picker is ever opened, so deferring
        // candidate discovery must not defer the policy that decides it.
        runTeamActionMock.mockClear();
        const profile = await upsertServerProfile({ name: 'Creation decision Home', serverUrl: 'https://creation-decision.example.test' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'creator' })).toString('base64url')}.signature`,
        });
        creationDecisionNetworkMode.enabled = true;
        const requests: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/auth/ping') return new Response('{}');
            if (parsed.pathname === '/v1/session-access/principals/resolve') {
                requests.push(JSON.parse(String(init?.body)));
                return new Response(JSON.stringify({ v: 1, principals: [], creationDecision: {
                    v: 1, teamId: 'team-local', teamName: 'Local Team', requiredByPolicy: true,
                    defaultGrant: { accessLevel: 'edit', canApprovePermissions: false }, externalSharingPolicy: 'allowed',
                } }));
            }
            return new Response('{}', { status: 404 });
        });
        let latest: NewSessionAccessDraftState | null = null;
        await renderScreen(<AccessDraftProbe serverId={profile.id} sourceRevision={1} sourceAccess={null}
            sourcePrimaryTeamId="team-local" popoverOpen={false}
            onReady={(state) => { latest = state; }} />);
        await vi.waitFor(() => expect(requests).toEqual([{ v: 1, subjects: [], creationTeamId: 'team-local' }]));
        expect(latest!.primaryTeamId).toBe('team-local');
    });

    it('uses the server creation decision instead of a conflicting directory policy', async () => {
        runTeamActionMock.mockResolvedValue({
            kind: 'succeeded', value: { items: [{
                id: 'team-local', name: 'Directory Required',
                policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'team_admins_only' },
            }], nextCursor: null },
        } as never);
        const profile = await upsertServerProfile({ name: 'Decision authority Home', serverUrl: 'https://decision-authority.example.test' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'creator' })).toString('base64url')}.signature`,
        });
        creationDecisionNetworkMode.enabled = true;
        setRuntimeFetch(async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/auth/ping') return new Response('{}');
            if (parsed.pathname === '/v1/session-access/principals/resolve') {
                return new Response(JSON.stringify({ v: 1, principals: [], creationDecision: {
                    v: 1, teamId: 'team-local', teamName: 'Server Private', requiredByPolicy: false,
                    defaultGrant: null, externalSharingPolicy: 'allowed',
                } }));
            }
            return new Response('{}', { status: 404 });
        });
        let latest: Controller | null = null;
        await renderScreen(<Probe initial={null} initialPrimaryTeamId="team-local" availability="available" demanded
            scope={{ serverId: profile.id, accountId: 'creator' }} onReady={(controller) => { latest = controller; }} />);

        await vi.waitFor(() => expect(latest!.model.context?.primaryTeamId).toBe('team-local'));
        expect(latest!.model.grants).toHaveLength(0);
        expect(latest!.model.grants[0]?.requiredByTeamPolicy).not.toBe(true);
        expect(latest!.model.context?.options.find((option) => option.teamId === 'team-local')?.blockedReason).toBeUndefined();
    });

    it('retries an unavailable creation decision through the existing content retry action', async () => {
        const profile = await upsertServerProfile({ name: 'Retry decision Home', serverUrl: 'https://retry-decision.example.test' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'creator' })).toString('base64url')}.signature`,
        });
        creationDecisionNetworkMode.enabled = true;
        let attempts = 0;
        setRuntimeFetch(async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/auth/ping') return new Response('{}');
            if (parsed.pathname === '/v1/session-access/principals/resolve') {
                const body = JSON.parse(String(init?.body ?? '{}')) as { creationTeamId?: string };
                if (!body.creationTeamId) return new Response(JSON.stringify({ v: 1, principals: [] }));
                attempts += 1;
                if (attempts === 1) return new Response('{}', { status: 503 });
                return new Response(JSON.stringify({ v: 1, principals: [], creationDecision: {
                    v: 1, teamId: 'team-retry', teamName: 'Retry Team', requiredByPolicy: true,
                    defaultGrant: { accessLevel: 'edit', canApprovePermissions: false }, externalSharingPolicy: 'allowed',
                } }));
            }
            return new Response('{}', { status: 404 });
        });
        let latest: Controller | null = null;
        await renderScreen(<Probe initial={null} initialPrimaryTeamId="team-retry" availability="available"
            scope={{ serverId: profile.id, accountId: 'creator' }} onReady={(controller) => { latest = controller; }} />);
        await vi.waitFor(() => expect(attempts).toBe(1));
        await act(async () => { latest!.actions.retryContent(); });
        await vi.waitFor(() => expect(attempts).toBe(2));
        await vi.waitFor(() => expect(latest!.model.grants[0]?.requiredByTeamPolicy).toBe(true));
    });
});
