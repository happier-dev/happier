import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SessionAgentCatalogIdentityIcon } from '../presentation/SessionAgentCatalogIdentityIcon';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListCacheEntryFromRenderable, buildSessionListRenderableFromCacheEntry } from '@/sync/domains/state/warmCacheAdapters';
import { SessionListCacheEntryV1Schema } from '@/sync/domains/state/warmCachePersistence';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
// The face's paint adapter is the platform boundary; the web one paints into the stubbed canvas below.
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

describe('SessionListIdentity', () => {
    afterEach(() => standardCleanup());
    it.each([
        { mode: 'lively' as const, reduced: false, plays: true },
        { mode: 'reactions' as const, reduced: false, plays: true },
        { mode: 'still' as const, reduced: false, plays: false },
        { mode: 'lively' as const, reduced: true, plays: false },
    ])('keeps an ordinary Bot row resting, with a finite hover/touch perk only when allowed: $mode, reduced=$reduced', async ({ mode, reduced, plays }) => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const settings = storage.getState().settings;
        resetReanimatedFrameCallbacks();
        vi.useFakeTimers();
        setReducedMotionPreferenceOverride(reduced);
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        storage.setState({ settings: { ...settings, botMotion: mode } });
        const session = createSessionFixture({ metadata: { path: '/repo', bot: { kind: 'bot' } } });
        const row = (mood: 'quiet' | 'working') => <SessionListIdentity session={session} display="avatar"
            serverId="server-a" color="currentColor" avatarSize={24} agentLogoSize={16} connected botActivity={mood} />;
        const frames = () => readReanimatedFrameCallbacks().filter(record => record.handle.isActive && record.handle.callbackId !== -1);
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(row('quiet'), { createNodeMock: node => node.type === 'canvas'
                ? { getContext: () => ({ putImageData() {} }) } : null });
            expect(frames()).toHaveLength(0);
            // Ordinary rows never join the rail's idle scheduler.
            expect(vi.getTimerCount()).toBe(0);
            const pointer = (event: 'onPointerEnter' | 'onPointerLeave' | 'onPointerDown', pointerType: 'mouse' | 'touch') => {
                const host = screen!.root.findAll(node => typeof node.type === 'string' && typeof node.props[event] === 'function')[0];
                expect(host).toBeDefined();
                act(() => host!.props[event]({ nativeEvent: { pointerType } }));
            };
            const settle = () => act(() => {
                for (let n = 0; n < 120; n++) for (const record of frames())
                    record.run({ timestamp: n * 16, timeSincePreviousFrame: 16, timeSinceFirstFrame: n * 16 });
            });
            pointer('onPointerEnter', 'mouse');
            expect(frames().length > 0).toBe(plays);
            settle();
            expect(frames()).toHaveLength(0);
            pointer('onPointerEnter', 'mouse');
            expect(frames()).toHaveLength(0);
            pointer('onPointerLeave', 'mouse');
            pointer('onPointerDown', 'touch');
            expect(frames().length > 0).toBe(plays);
            settle();
            await screen.update(row('working'));
            expect(frames()).toHaveLength(0); // No activity reaction or working breath in ordinary rows.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await screen?.unmount();
            storage.setState({ settings });
            setReducedMotionPreferenceOverride(null);
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });
    it('keeps a roster face on the canonical Turn outcome when its display projection omits runtime fields', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const { BotFace } = await import('@/components/sessions/bots/face/BotFace');
        const { createSessionListPresentationSource } = await import('@/sync/domains/session/listing/sessionListRenderableSessionProjection');
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        const session = createSessionFixture({ id: 'failed-roster-bot', latestTurnStatus: 'failed', latestTurnStatusObservedAt: 20,
            metadata: { path: '/repo', machineId: 'machine-a', bot: { kind: 'bot' } } as ReturnType<typeof createSessionFixture>['metadata'] });
        const row = buildSessionListRenderableFromSession(session);
        const source = createSessionListPresentationSource(row, { baseSession: session, serverId: 'server-a' });
        const screen = await renderScreen(<SessionListIdentity session={session} presentationSource={source}
            display="avatar" roster serverId="server-a" color="currentColor" avatarSize={24} agentLogoSize={16} connected />,
            { createNodeMock: node => node.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : null });
        expect(screen.findByType(BotFace).props).toMatchObject({ mood: 'failed', failedAt: 20 });
        await screen.unmount();
        vi.unstubAllGlobals();
    });
    it('uses canonical Auto admission and preserves all authored identity choices', async () => {
        const { normalizeSessionListIdentityDisplay } = await import('./SessionListIdentity');
        for (const value of ['auto', 'agentLogo', 'project', 'projectWithAgent', 'agentWithTrailingProject', 'avatar', 'none']) {
            expect(normalizeSessionListIdentityDisplay(value)).toBe(value);
        }
        expect(normalizeSessionListIdentityDisplay(undefined)).toBe('auto');
        expect(normalizeSessionListIdentityDisplay('unrecognized')).toBe('auto');
    });
    it('projects the selected provider logo with the exact Home context', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: {
                path: '/repo',
                machineId: 'machine-a',
                flavor: 'codex',
            } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                serverId="server-a"
                color="currentColor"
                avatarSize={28}
                agentLogoSize={22}
                connected={true}
                testID="identity"
            />,
        );

        expect(screen.tree.root.findByType(SessionAgentCatalogIdentityIcon).props).toMatchObject({
            agentId: 'codex',
            machineId: 'machine-a',
            serverId: 'server-a',
            size: 22,
            testID: 'identity',
        });
        expect(screen.tree.root.findAllByType('Avatar')).toHaveLength(0);
    });

    it.each([
        { identity: { runtimeDescriptorV1: { v: 1 as const, agentId: 'acme.agent', agent: {}, provider: {} } }, expected: 'acme.agent' },
        { identity: { flavor: 'codex-acp' }, expected: 'codex' },
        { identity: {}, expected: null },
    ])('retains Agent presentation through compact and persisted cache rows: $expected', async ({ identity, expected }) => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const full = createSessionFixture({ metadataLayoutVersion: 0,
            metadata: { path: '/repo', host: 'home', ...identity } });
        const compact = buildSessionListRenderableFromSession(full);
        const persisted = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(buildSessionListCacheEntryFromRenderable(compact))));
        const restored = buildSessionListRenderableFromCacheEntry(persisted);
        for (const session of [full, compact, restored]) {
            const screen = await renderScreen(<SessionListIdentity session={session} display="agentLogo"
                serverId="home" color="currentColor" avatarSize={28} agentLogoSize={22} connected={true} />);
            expect(screen.tree.root.findByType(SessionAgentCatalogIdentityIcon).props.agentId).toBe(expected ?? '');
            await screen.unmount();
        }
    });

    it('leads with the Project favicon, with the Agent as a cut-out badge only when chosen (lab clctx:marks)', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: { path: '/repo', machineId: 'machine-a', flavor: 'codex' } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const favicon = { status: 'found' as const, uri: 'data:image/png;base64,AAAA', relativePath: 'favicon.png' };
        const render = (display: 'project' | 'projectWithAgent', projectFavicon: typeof favicon | null) => renderScreen(
            <SessionListIdentity session={session} display={display} projectFavicon={projectFavicon}
                serverId="server-a" color="currentColor" avatarSize={28} agentLogoSize={16} connected={true} testID="identity" />,
        );

        const both = await render('projectWithAgent', favicon);
        expect(both.tree.root.findByProps({ testID: 'identity-project-favicon' }).props.source).toEqual({ uri: favicon.uri });
        const badge = both.tree.root.findByType(SessionAgentCatalogIdentityIcon).props;
        expect(badge).toMatchObject({ agentId: 'codex', machineId: 'machine-a', serverId: 'server-a' });
        expect(badge.size).toBeLessThan(16);
        await both.unmount();

        // No favicon: the folder fallback keeps the slot and the badge, never a blank glyph.
        const fallback = await render('projectWithAgent', null);
        expect(fallback.tree.root.findAllByProps({ testID: 'identity-project-favicon' })).toHaveLength(0);
        expect(fallback.tree.root.findAllByProps({ testID: 'identity-project-fallback' }).length).toBeGreaterThan(0);
        expect(fallback.tree.root.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(1);
        await fallback.unmount();

        // Project alone: the favicon leads and the Agent stays in accessible detail only.
        const project = await render('project', favicon);
        expect(project.tree.root.findAllByProps({ testID: 'identity-project-favicon' }).length).toBeGreaterThan(0);
        expect(project.tree.root.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(0);
        await project.unmount();
    });

    it('gives a Bot its Living Bot face where the list shows avatars, keeping ordinary Sessions on the avatar', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const { BotFace } = await import('@/components/sessions/bots/face/BotFace');
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        const canvas = { createNodeMock: (node: { type: unknown }) => node.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : null };
        const metadata = { path: '/repo', machineId: 'machine-a', flavor: 'codex', bot: { kind: 'bot' } } as ReturnType<typeof createSessionFixture>['metadata'];
        const first = createSessionFixture({ id: 'bot-release-captain', metadata });
        const second = createSessionFixture({ id: 'bot-flake-hunter', metadata });
        const render = (session: ReturnType<typeof createSessionFixture>, extra: Partial<{ connected: boolean; roster: boolean; botActivity: 'quiet' | 'working' | 'needsYou' }> = {}) => renderScreen(
            <SessionListIdentity session={session} display="avatar" serverId="server-a" color="currentColor" avatarSize={28} agentLogoSize={16}
                connected={extra.connected ?? true} roster={extra.roster} botActivity={extra.botActivity} testID="identity" />, canvas);

        const a = await render(first, { botActivity: 'working' });
        const faceA = a.findByType(BotFace).props;
        expect(faceA).toMatchObject({ style: 'dither', size: 28, mood: 'working' });
        expect(a.tree.root.findAllByType('Avatar' as never)).toHaveLength(0);
        await a.unmount();
        // Two Bots in one folder are two faces: the seed is the Session, not the folder.
        const b = await render(second);
        expect([b.findByType(BotFace).props.identity.body, b.findByType(BotFace).props.identity.colour])
            .not.toEqual([faceA.identity.body, faceA.identity.colour]);
        expect(b.findByType(BotFace).props.mood).toBe('quiet');
        await b.unmount();
        // A saved face wins, in every surface that shows it; a sleeping Bot keeps its colour (lab R6 shell).
        const saved = createSessionFixture({ id: 'bot-release-captain', metadata: { ...metadata, botFace: { style: 'planet', body: 'crab', palette: 'moss' } } as typeof metadata });
        const offline = await render(saved, { connected: false });
        expect(offline.findByType(BotFace).props).toMatchObject({ style: 'planet', identity: { body: 'crab', colour: 'moss', seed: faceA.identity.seed } });
        expect(offline.findByType(BotFace).props.monochrome).not.toBe(true);
        await offline.unmount();

        const ordinary = await render(createSessionFixture({ metadata: { path: '/repo', machineId: 'machine-a', flavor: 'codex' } as typeof metadata }));
        expect(ordinary.tree.root.findAllByType(BotFace)).toHaveLength(0);
        expect(ordinary.tree.root.findAllByType('Avatar' as never)).toHaveLength(1);
        await ordinary.unmount();
        vi.unstubAllGlobals();
    });

    it('draws a Bot by its face on every identity display, never as an Agent glyph or a Project mark (Living Bots lab)', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const { BotFace } = await import('@/components/sessions/bots/face/BotFace');
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        const session = createSessionFixture({ id: 'bot-coffee-companion',
            metadata: { path: '/repo', machineId: 'machine-a', flavor: 'codex', bot: { kind: 'bot' } } as ReturnType<typeof createSessionFixture>['metadata'] });
        for (const display of ['agentLogo', 'agentWithTrailingProject', 'project', 'projectWithAgent'] as const) {
            const screen = await renderScreen(<SessionListIdentity session={session} display={display} serverId="server-a" color="currentColor"
                avatarSize={28} agentLogoSize={16} connected testID="identity" />,
                { createNodeMock: node => node.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : null });
            expect(screen.findByType(BotFace).props.size).toBe(16);
            expect(screen.tree.root.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(0);
            await screen.unmount();
        }
        vi.unstubAllGlobals();
    });

    it('marks a coordinator with a labelled sub-badge on every identity display, and only then (lab P3·L)', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: { path: '/repo', machineId: 'machine-a', flavor: 'codex' } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const favicon = { status: 'found' as const, uri: 'data:image/png;base64,AAAA', relativePath: 'favicon.png' };
        const render = (display: 'agentLogo' | 'avatar' | 'project' | 'projectWithAgent', coordinator: boolean | undefined) => renderScreen(
            <SessionListIdentity session={session} display={display} projectFavicon={favicon} coordinator={coordinator}
                serverId="server-a" color="currentColor" avatarSize={28} agentLogoSize={16} connected={true} testID="identity" />,
        );
        const marks = (screen: Awaited<ReturnType<typeof render>>) =>
            screen.tree.root.findAllByProps({ testID: 'identity-coordinator-mark' });

        for (const display of ['agentLogo', 'avatar', 'project', 'projectWithAgent'] as const) {
            const on = await render(display, true);
            expect(marks(on).map(node => node.props.accessibilityLabel)).toContain('Coordinator');
            await on.unmount();
            for (const coordinator of [false, undefined]) {
                const off = await render(display, coordinator);
                expect(marks(off)).toHaveLength(0);
                await off.unmount();
            }
        }
        // The Agent badge of a Project-led mark keeps its corner.
        const both = await render('projectWithAgent', true);
        expect(both.tree.root.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(1);
        await both.unmount();
    });

    it('dims the provider logo for a session that is not live, as the avatar is greyed', async () => {
        const { lightTheme } = await import('@/theme');
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const render = (session: ReturnType<typeof createSessionFixture>, connected: boolean) => renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                serverId="server-a"
                color={lightTheme.colors.text.secondary}
                avatarSize={28}
                agentLogoSize={22}
                connected={connected}
            />,
        );
        const logoColor = (screen: Awaited<ReturnType<typeof render>>) =>
            screen.tree.root.findByType(SessionAgentCatalogIdentityIcon).props.color;

        expect(logoColor(await render(createSessionFixture({ active: true }), true))).toBe(lightTheme.colors.text.secondary);
        expect(logoColor(await render(createSessionFixture({ active: false }), true))).toBe(lightTheme.colors.text.tertiary);
        expect(logoColor(await render(createSessionFixture({ active: true }), false))).toBe(lightTheme.colors.text.tertiary);
    });

    it('keeps a Bot roster identity in colour while the Bot sleeps (its state is the subtitle, lab b-rail A)', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const asleep = createSessionFixture({ active: false });
        const render = (roster: boolean) => renderScreen(
            <SessionListIdentity session={asleep} display="avatar" serverId="server-a" color="currentColor"
                avatarSize={28} agentLogoSize={22} connected={false} roster={roster} />,
        );
        const list = await render(false);
        expect(list.tree.root.findByType('Avatar').props.monochrome).toBe(true);
        await list.unmount();
        const roster = await render(true);
        expect(roster.tree.root.findByType('Avatar').props.monochrome).toBe(false);
        await roster.unmount();
    });

    it('leaves an unresolved list-only provider to the catalog identity fallback', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = {
            id: 'background-session',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: { path: '/repo', machineId: 'machine-b', flavor: null },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        };
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                serverId="server-b"
                color="currentColor"
                avatarSize={28}
                agentLogoSize={22}
                connected={false}
            />,
        );

        expect(screen.tree.root.findByType(SessionAgentCatalogIdentityIcon).props).toMatchObject({
            agentId: '',
            machineId: 'machine-b',
            serverId: 'server-b',
        });
        expect(screen.tree.root.findAllByType('Avatar')).toHaveLength(0);
    });
});
