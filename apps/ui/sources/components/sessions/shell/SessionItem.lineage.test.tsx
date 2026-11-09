import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installAgentAssetLoader } from '@/dev/testkit/mocks/agentAssets';
import { createSessionItemTestRowModel } from './sessionShellTestHelpers';

// Native rendering and navigation are the boundaries; row/menu/domain logic remains real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const serverContext = vi.hoisted(() => ({
    resolve: vi.fn<(params?: unknown) => Promise<any>>(async () => ({ scope: 'active' as const, timeoutMs: 1 })),
}));
beforeEach(() => {
    installAgentAssetLoader();
    serverContext.resolve.mockReset();
    serverContext.resolve.mockResolvedValue({ scope: 'active', timeoutMs: 1 });
});

const http = vi.hoisted(() => ({ serverFetch: vi.fn(), runtimeFetchWithServerReachability: vi.fn() }));
// The sync engine's socket CAS writer is the boundary here; its retry/merge contract is proven in updateSessionMetadataWithRetry.test.ts.
const sync = vi.hoisted(() => ({ patch: vi.fn(), send: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => ({ patchSessionMetadataWithRetry: sync.patch }) }));
// The pending-outbox transport is the delivery boundary; its contract is owned by the outbox tests.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({ sendSessionMessageWithServerScope: sync.send }));
// Server-scope credential resolution is a boundary; this row's server is the active account.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext', () => ({
    resolveServerScopedSessionContext: serverContext.resolve,
}));
vi.mock('@/sync/http/client', () => ({ serverFetch: http.serverFetch }));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({ runtimeFetchWithServerReachability: http.runtimeFetchWithServerReachability }));

describe('session lineage row', () => {
    it('renders a Delegate role before the avatar without moving the card edge, and keeps disclosure as the final trailing control', async () => {
        const { SessionItem } = await import('./SessionItem');
        const { t } = await import('@/text');
        const origin = { v: 1, kind: 'agent', creatorSessionId: 'planner' } as const;
        const session = createSessionFixture({ id: 'delegate', metadata: { path: '/repo', host: 'host', flavor: 'codex',
            sessionOriginV1: origin, sessionRoleV1: { v: 1, role: 'delegate' } } });
        const originalSession = structuredClone(session);
        const base = { identityDisplay: 'avatar' as const, agentStarted: true, parentSessionId: 'planner', nestingDepth: 1,
            hasChildren: true, childrenCollapsed: false };
        const roleModel = createSessionItemTestRowModel({ session, serverId: 'home' }, { ...base, role: 'delegate' });
        const noRoleModel = createSessionItemTestRowModel({ session, serverId: 'home' }, { ...base, role: null });
        const toggle = vi.fn();
        const withRole = await renderScreen(<SessionItem session={session} rowModel={roleModel} onToggleSessionChildren={toggle} />);
        const withoutRole = await renderScreen(<SessionItem session={session} rowModel={noRoleModel} onToggleSessionChildren={toggle} />);

        const row = withRole.findByTestId('session-list-item-delegate');
        if (!row) throw new Error('Missing row');
        const ordered = row.findAll(() => true);
        const indexOf = (match: (node: typeof ordered[number]) => boolean) => ordered.findIndex(match);
        const badgeIndex = indexOf(node => node.props.testID === 'session-role-badge-delegate');
        // SessionListIdentity is memoized; match its element by its identity props.
        const identityIndex = indexOf(node => node.props.display === 'avatar' && typeof node.props.avatarSize === 'number');
        const rightAreaIndex = indexOf(node => node.props.testID === 'session-item-right-area');
        const disclosureIndex = indexOf(node => node.props.testID === 'session-children-toggle-delegate');
        expect(badgeIndex).toBeGreaterThan(-1);
        expect(row.findAll(node => node.props.testID === 'session-role-badge-delegate' && typeof node.props.children === 'string')
            .map(node => node.props.children)).toContain(t('sessionRole.delegate'));
        expect(badgeIndex).toBeLessThan(identityIndex);
        expect(rightAreaIndex).toBeGreaterThan(identityIndex);
        expect(disclosureIndex).toBeGreaterThan(rightAreaIndex);
        // The disclosure is the last direct control of the card.
        const directChildren = React.Children.toArray(row.props.children).filter(React.isValidElement);
        expect((directChildren.at(-1)?.props as { testID?: string }).testID).toBe('session-children-toggle-delegate');

        // No-role rows reserve no role gutter; both rows keep the same outer card edge (nesting margin).
        expect(withoutRole.findAll(node => node.props.testID === 'session-role-badge-delegate')).toHaveLength(0);
        const outerStyle = (screen: typeof withRole) => {
            const container = screen.findByTestId('session-list-item-delegate')?.parent;
            return JSON.stringify(container?.props.style);
        };
        expect(outerStyle(withRole)).toBe(outerStyle(withoutRole));

        const disclosure = withRole.findByTestId('session-children-toggle-delegate');
        if (!disclosure) throw new Error('Missing session disclosure');
        expect(disclosure.props.accessibilityState).toEqual({ expanded: true });
        const stopPropagation = vi.fn();
        await React.act(async () => { disclosure.props.onPress({ stopPropagation }); });
        expect(toggle).toHaveBeenCalledWith('sessionChildren:home:delegate');
        expect(session).toEqual(originalSession);
        expect(roleModel).toMatchObject({ agentStarted: true, parentSessionId: 'planner', nestingDepth: 1 });
    });

    it('renders a deleted custom profile from the session snapshot without a catalog entry', async () => {
        const { SessionItem } = await import('./SessionItem');
        const customRole = 'custom:123e4567-e89b-12d3-a456-426614174000' as const;
        const snapshot = { v: 1 as const, role: customRole, name: 'Architect', color: '#123456' as const, instructions: 'Design.' };
        const session = createSessionFixture({
            id: 'custom-role',
            metadata: { path: '/repo', host: 'host', flavor: 'codex', sessionRoleV1: snapshot },
        });
        const rowModel = createSessionItemTestRowModel({ session, serverId: 'home' }, {
            role: customRole,
            roleName: snapshot.name,
            roleColor: snapshot.color,
        });
        const screen = await renderScreen(<SessionItem session={session} rowModel={rowModel} />);
        const badge = screen.findByTestId('session-role-badge-custom-role');
        expect(badge).toBeTruthy();
        expect(badge?.props.children).toBe('Architect');
        expect(screen.tree.root.findAll(node => (JSON.stringify(node.props.style) ?? '').includes(snapshot.color))).not.toHaveLength(0);
        expect(session.metadata?.sessionRoleV1).toBe(snapshot);
    });

    it('never falls back to active-account custom role choices when the row target account is unresolved', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { SessionItem } = await import('./SessionItem');
        const activeId = 'custom:123e4567-e89b-12d3-a456-426614174000';
        getStorage().setState((state) => ({
            settings: {
                ...state.settings,
                sessionRoleProfilesV1: {
                    v: 1,
                    instructionsByRole: {},
                    customRoles: [{ id: activeId, name: 'Wrong account', instructions: 'Wrong.', color: '#123456' }],
                },
            },
        }));
        serverContext.resolve.mockResolvedValue({
            scope: 'scoped',
            targetServerId: 'server-foreign',
            targetAccountId: 'account-foreign',
            timeoutMs: 1,
        });
        const session = createSessionFixture({ id: 'foreign-row', metadata: { path: '/repo', host: 'host', flavor: 'codex' } });
        const rowModel = createSessionItemTestRowModel({ session, serverId: 'server-foreign' });
        const screen = await renderScreen(<SessionItem session={session} rowModel={rowModel} nativeContextMenuOpen />);
        await React.act(async () => screen.findAll(node => typeof node.props.onPointerEnter === 'function')[0].props.onPointerEnter({ pointerType: 'mouse' }));
        const menu = screen.tree.root.findAll(node => Array.isArray(node.props.items) && node.props.placement === 'left')[0];
        const roleItem = menu.props.items.find((item: { id: string }) => item.id === 'sessionRole');
        expect(roleItem.submenu.items.map((item: { id: string }) => item.id)).toEqual([
            'sessionRole:project_lead', 'sessionRole:planner', 'sessionRole:worker', 'sessionRole:reviewer', 'sessionRole:none',
        ]);
    });

    it('offers Make standalone for a nested row and changes only its sidebar placement', async () => {
        const { SessionItem } = await import('./SessionItem');
        const { t } = await import('@/text');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        const profile = upsertServerProfile({ serverUrl: 'https://lineage-appearance.example.test' });
        // Credential storage and HTTP are system boundaries; the real menu, writer and store run.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: 'test', secret: Buffer.alloc(32, 7).toString('base64url') });
        invalidateAccountEncryptionModeCache();
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
        http.serverFetch.mockImplementation(async () => json({ mode: 'plain', updatedAt: 0 }));
        const writes: unknown[] = [];
        http.runtimeFetchWithServerReachability.mockImplementation(async ({ init }) => {
            const { presentation } = JSON.parse(String(init.body));
            writes.push(presentation);
            return json({ presentation: { sessionId: 'implementer', presentation, updatedAt: 2 } });
        });
        const session = createSessionFixture({ id: 'implementer', serverId: profile.id, metadata: { path: '/repo', host: 'host', flavor: 'codex',
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'actual-creator' }, sessionRoleV1: { v: 1, role: 'delegate' } } });
        const parent = createSessionFixture({ id: 'planner', serverId: profile.id, metadata: { path: '/repo', host: 'host', flavor: 'codex' } });
        const originalSession = structuredClone(session);
        const retainedColor = { kind: 'accent' as const, key: 'green' };
        const retainedPresentation = {
            v: 1 as const,
            placement: { kind: 'session' as const, parentSessionId: 'planner' },
            identity: 'agent' as const,
        };
        const key = `${profile.id}:implementer`;
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        getStorage().setState({
            sessions: { [session.id]: session, [parent.id]: parent },
            sessionListViewDataByServerId: { [profile.id]: [session, parent].map(candidate => ({
                type: 'session' as const,
                serverId: profile.id,
                session: buildSessionListRenderableFromSession(candidate),
            })) },
            sessionOrganizationSessionAppearancesSupportedByServerId: { [profile.id]: true },
            sessionOrganizationAppearancePresentationsSupportedByServerId: { [profile.id]: true },
            sessionOrganizationAppearancesBySessionKey: {
                [key]: { sessionId: session.id, display: { t: 'plain', v: { color: retainedColor } }, updatedAt: 1 },
            },
            sessionOrganizationAppearancePresentationsBySessionKey: {
                [key]: { sessionId: session.id, presentation: { t: 'plain', v: retainedPresentation }, updatedAt: 1 },
            },
        });
        const rowModel = createSessionItemTestRowModel({ session, serverId: profile.id },
            {
                agentStarted: true,
                role: 'delegate',
                parentSessionId: 'planner',
                nestingDepth: 1,
                appearancePresentationSupported: true,
            });
        const screen = await renderScreen(<SessionItem session={session} rowModel={rowModel} nativeContextMenuOpen onSetSessionAppearance={() => undefined} />);
        await React.act(async () => { screen.findAll(node => typeof node.props.onPointerEnter === 'function')[0].props.onPointerEnter({ pointerType: 'mouse' }); });
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.placement === 'left');
        const ids: string[] = menu()?.props.items.map((item: { id: string }) => item.id) ?? [];
        expect(ids).toContain('sessionPlacement.makeStandalone');
        expect(ids).not.toContain('sessionPlacement.nestUnder');
        const provenance = menu()?.props.items.find((item: { id: string }) => item.id === 'lineage.provenance');
        expect(provenance).toMatchObject({
            title: t('sessionLineage.createdBy', { sessionId: 'actual-creator' }),
            disabled: true,
        });
        expect(JSON.stringify(provenance)).not.toContain(t('sessionLineage.agentStarted'));
        for (const superseded of ['lineage.move', 'lineage.breakOut', 'lineage.mainAppearance', 'lineage.promote', 'lineage.restore']) {
            expect(ids).not.toContain(superseded);
        }
        sync.send.mockClear();
        await React.act(async () => { await menu()?.props.onSelect('sessionPlacement.makeStandalone'); });
        expect(writes).toEqual([{ t: 'plain', v: { ...retainedPresentation, placement: { kind: 'topLevel' } } }]);
        expect(getStorage().getState().sessionOrganizationAppearancePresentationsBySessionKey[key]?.presentation)
            .toEqual({ t: 'plain', v: { ...retainedPresentation, placement: { kind: 'topLevel' } } });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey[key]?.display)
            .toEqual({ t: 'plain', v: { color: retainedColor } });
        expect(sync.send).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: session.id,
            serverId: profile.id,
            localId: expect.any(String),
            requestedAction: { v: 1, kind: 'enqueue' },
            message: expect.stringContaining(parent.id),
        }));
        const lastPlacementSend = sync.send.mock.calls.at(-1) as unknown as [{ message?: string }] | undefined;
        expect(lastPlacementSend?.[0]?.message).toContain('Stop treating');
        // Provenance, role, and session data are untouched.
        expect(session).toEqual(originalSession);
        vi.restoreAllMocks();
    });
    it('offers Nest under for a top-level row and a checked Set role submenu that writes only the role', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().setState({ sessionOrganizationSessionAppearancesSupportedByServerId: { home: true } });
        const { SessionItem } = await import('./SessionItem');
        const { t } = await import('@/text');
        const session = createSessionFixture({ id: 'planner', owner: 'u1', metadata: { path: '/repo', host: 'host', flavor: 'codex',
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'coordinator' }, sessionRoleV1: { v: 1, role: 'planner' } } });
        let stored: Record<string, unknown> = { ...session.metadata };
        sync.patch.mockImplementation(async (_sessionId: string, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            stored = updater(stored);
        });
        const rowModel = createSessionItemTestRowModel(
            { session, serverId: 'home' },
            { role: 'planner', appearancePresentationSupported: true },
        );
        const screen = await renderScreen(<SessionItem session={session} rowModel={rowModel}
            nativeContextMenuOpen onSetSessionAppearance={() => undefined} />);
        await React.act(async () => {
            screen.findAll(node => typeof node.props.onPointerEnter === 'function')[0].props.onPointerEnter({ pointerType: 'mouse' });
            await Promise.resolve();
        });
        const menu = () => screen.tree.root.findAll(node => Array.isArray(node.props.items) && node.props.placement === 'left')[0];
        const items: { id: string; submenu?: { items: { id: string; title: string; rightElement?: unknown }[] } }[] = menu().props.items;
        const ids = items.map(item => item.id);
        expect(ids).toContain('sessionPlacement.nestUnder');
        expect(ids).not.toContain('sessionPlacement.makeStandalone');
        // At most two new commands, placed together immediately before lifecycle actions.
        expect(ids.indexOf('sessionRole')).toBe(ids.indexOf('sessionPlacement.nestUnder') + 1);
        const roleItem = items.find(item => item.id === 'sessionRole');
        expect(roleItem?.submenu?.items.map(item => [item.title, item.rightElement !== undefined])).toEqual([
            [t('sessionRole.projectLead'), false],
            [t('sessionRole.planner'), true],
            [t('sessionRole.worker'), false],
            [t('sessionRole.reviewer'), false],
            [t('sessionRole.none'), false],
        ]);
        await React.act(async () => { await menu().props.onSelect('sessionRole:worker'); });
        const { DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1, buildSessionRoleAssignmentMessageV1, buildSessionRoleClearedMessageV1 } = await import('@happier-dev/protocol');
        const { sessionRoleV1: assigned, ...rest } = stored;
        expect(rest).toEqual((({ sessionRoleV1: _prior, ...others }) => others)(session.metadata as Record<string, unknown>));
        expect(assigned).toMatchObject({ v: 1, role: 'worker', instructions: DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.worker });
        expect(sync.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'planner', serverId: 'home',
            message: buildSessionRoleAssignmentMessageV1({ role: 'worker', instructions: DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.worker }) }));
        await React.act(async () => { await menu().props.onSelect('sessionRole:none'); });
        const { sessionRoleV1: _cleared, ...withoutRole } = session.metadata as Record<string, unknown>;
        expect(stored).toEqual(withoutRole);
        expect(sync.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: buildSessionRoleClearedMessageV1() }));

        // A clear whose instruction cannot be queued must not claim a role is set.
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => undefined);
        sync.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' } as never);
        await React.act(async () => { await menu().props.onSelect('sessionRole:none'); });
        expect(alert).toHaveBeenCalledWith(t('common.error'), t('sessionRole.changeNotDelivered'), expect.any(Array));
        alert.mockRestore();
        expect(sync.patch).toHaveBeenCalledWith('planner', expect.any(Function), { serverId: 'home' });
    });
    it.each(['avatar', 'agentLogo', 'none'] as const)('keeps an operable disclosure without a textual agent-started tag with %s identity', async identityDisplay => {
        const { SessionItem } = await import('./SessionItem');
        const session = createSessionFixture({ id: 'implementer', metadata: { path: '/repo', host: 'host', flavor: 'codex',
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'planner' } } });
        const rowModel = createSessionItemTestRowModel({ session, serverId: 'home' }, {
            identityDisplay, agentStarted: true, hasChildren: true, childrenCollapsed: false,
        });
        const toggle = vi.fn();
        const screen = await renderScreen(<SessionItem session={session} rowModel={rowModel} onToggleSessionChildren={toggle} />);
        expect(screen.findByTestId('session-agent-started-implementer')).toBeFalsy();
        const disclosure = screen.findByTestId('session-children-toggle-implementer');
        if (!disclosure) throw new Error('Missing session disclosure');
        expect(disclosure.props.accessibilityState).toEqual({ expanded: true });
        const stopPropagation = vi.fn();
        await React.act(async () => { disclosure.props.onPress({ stopPropagation }); });
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(toggle).toHaveBeenCalledWith('sessionChildren:home:implementer');
    });

    it('indents a third-tier session farther inward than its immediate parent', async () => {
        const { SessionItem } = await import('./SessionItem');
        const { en } = await import('@/text/translations/en');
        const session = createSessionFixture({ id: 'nested-depth', metadata: { path: '/repo', host: 'host', flavor: 'codex' } });
        const marginLeftAtDepth = async (nestingDepth: number) => {
            const rowModel = createSessionItemTestRowModel({ session, serverId: 'home' }, { nestingDepth });
            const screen = await renderScreen(<SessionItem session={session} rowModel={rowModel} />);
            const style = screen.findByTestId(`session-list-item-${session.id}`)?.parent?.props.style;
            const flattened = (Array.isArray(style) ? style : [style]).reduce<Record<string, unknown>>(
                (result, value) => value && typeof value === 'object' ? { ...result, ...value } : result,
                {},
            );
            return Number(flattened.marginLeft ?? 0);
        };
        const topLevel = await marginLeftAtDepth(0);
        const depthOne = await marginLeftAtDepth(1);
        const depthTwo = await marginLeftAtDepth(2);
        expect(topLevel).toBe(0);
        expect(depthOne).toBeGreaterThan(topLevel);
        expect(depthTwo).toBeGreaterThan(depthOne);
        expect(en.sessionLineage.expand).toBe('Show subsessions');
        expect(en.sessionLineage.collapse).toBe('Hide subsessions');
    });

    it('presents queued, retryable, uncertain, and superseded placement delivery truthfully', async () => {
        const { presentSessionParentPlacementDeliveryResult } = await import('@/components/sessions/selection/showSessionParentPicker');
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => undefined);

        presentSessionParentPlacementDeliveryResult({ ok: true, placement: 'session', instructionLocalId: 'nested-1' });
        expect(alert).toHaveBeenLastCalledWith(t('common.success'), t('sessionLineage.nestedInstructionQueued'));
        presentSessionParentPlacementDeliveryResult({ ok: true, placement: 'topLevel', instructionLocalId: 'standalone-1' });
        expect(alert).toHaveBeenLastCalledWith(t('common.success'), t('sessionLineage.standaloneInstructionQueued'));

        const retry = vi.fn(async () => ({ ok: true as const, placement: 'session' as const, instructionLocalId: 'nested-2' }));
        presentSessionParentPlacementDeliveryResult({
            ok: false,
            stage: 'delivery',
            placement: 'session',
            errorCode: 'session_not_found',
            error: 'session_not_found',
            instruction: { localId: 'nested-2', message: 'report' },
            retry,
        });
        expect(alert).toHaveBeenLastCalledWith(t('common.error'), t('sessionLineage.nestedInstructionQueueFailed'), expect.any(Array));
        const retryButtons = alert.mock.calls.at(-1)?.[2];
        await React.act(async () => { retryButtons?.find(button => button.text === t('common.retry'))?.onPress?.(); });
        expect(retry).toHaveBeenCalledOnce();

        presentSessionParentPlacementDeliveryResult({
            ok: false,
            stage: 'delivery',
            placement: 'topLevel',
            errorCode: 'session_not_found',
            error: 'session_not_found',
            instruction: { localId: 'standalone-2', message: 'clear' },
            retry: vi.fn(),
        });
        expect(alert).toHaveBeenLastCalledWith(t('common.error'), t('sessionLineage.standaloneInstructionQueueFailed'), expect.any(Array));
        presentSessionParentPlacementDeliveryResult({
            ok: false,
            stage: 'delivery_uncertain',
            placement: 'session',
            error: 'unknown',
            instruction: { localId: 'nested-3', message: 'report' },
        });
        expect(alert).toHaveBeenLastCalledWith(t('common.error'), t('sessionLineage.instructionDeliveryUncertain'));

        presentSessionParentPlacementDeliveryResult({
            ok: false,
            stage: 'not_current',
            placement: 'session',
            error: 'placement_superseded',
            instruction: { localId: 'nested-4', message: 'stale' },
        });
        expect(alert).toHaveBeenLastCalledWith(
            t('common.info'),
            t('sessionLineage.instructionNotSentPlacementChanged'),
        );
        alert.mockRestore();
    });

    it('renders turn and Lead-delivery state as two separate row indicators', async () => {
        const { SessionItem } = await import('./SessionItem');
        const { t } = await import('@/text');
        const session = createSessionFixture({
            id: 'reviewer',
            latestTurnStatus: 'completed',
            metadata: {
                path: '/repo',
                host: 'host',
                flavor: 'codex',
                sessionOriginV1: {
                    v: 1,
                    kind: 'agent',
                    creatorSessionId: 'lead',
                    via: { kind: 'execution_run', runId: 'run-1' },
                },
                executionRunLinkV1: {
                    v: 1,
                    parentSessionId: 'lead',
                    runId: 'run-1',
                    turnEpoch: 2,
                    delivery: { turnEpoch: 2, status: 'verified', localId: 'completion-1', transcriptSeq: 12, verifiedAt: 120 },
                },
            },
        });
        const rowModel = createSessionItemTestRowModel({ session, serverId: 'home' }, {
            executionRunStatus: { turnState: 'finished', deliveryState: 'sent' },
        });
        const screen = await renderScreen(<SessionItem session={session} rowModel={rowModel} />);

        expect(screen.findByTestId('session-list-execution-run-status-reviewer')).toBeTruthy();
        expect(screen.findByTestId('session-list-turn-status-reviewer')?.props.children)
            .toBe(t('executionRunDelivery.turnFinished'));
        expect(screen.findByTestId('session-list-delivery-status-reviewer')?.props.children)
            .toBe(t('executionRunDelivery.sent'));
    });
});
