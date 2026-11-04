import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('SessionListIdentity', () => {
    afterEach(() => standardCleanup());
    it('uses canonical Auto admission and preserves all authored identity choices', async () => {
        const { normalizeSessionListIdentityDisplay } = await import('./SessionListIdentity');
        for (const value of ['auto', 'agentLogo', 'project', 'projectWithAgent', 'agentWithTrailingProject', 'avatar', 'none']) {
            expect(normalizeSessionListIdentityDisplay(value)).toBe(value);
        }
        expect(normalizeSessionListIdentityDisplay(undefined)).toBe('auto');
        expect(normalizeSessionListIdentityDisplay('unrecognized')).toBe('auto');
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
