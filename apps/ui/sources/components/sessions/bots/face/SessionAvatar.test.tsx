import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
// The face's paint adapter is the platform boundary; the web one paints into the stubbed canvas below.
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

// Load the real store/UI graph before the test's platform interaction window begins.
const { SessionAvatar } = await import('./SessionAvatar');
const { BotFace } = await import('./BotFace');

describe('SessionAvatar', () => {
    afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

    it('repaints saved shape changes without changing the fallback body or colour, and restores the fallback when cleared', async () => {
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        const paints: Uint8ClampedArray[] = [];
        const canvas = { createNodeMock: (node: { type: unknown }) => node.type === 'canvas' ? {
            getContext: () => ({ putImageData(image: { data: Uint8ClampedArray }) { paints.push(image.data); } }),
        } : null };
        const shape = { v: 1 as const, fill: ['M5 5 L85 5 L85 85 L5 85 Z'], mouth: [45, 48, 0.8] as [number, number, number] };
        const session = (outline?: typeof shape) => createSessionFixture({ id: 'shape-change', metadata: {
            path: '/repo', host: 'tester.local', machineId: 'm', bot: { kind: 'bot' },
            botFace: { body: 'crab', palette: 'moss', style: 'pixel', ...(outline ? { shape: outline } : {}) },
        } });
        const screen = await renderScreen(<SessionAvatar session={session()} serverId="home-a" size={24} />, canvas);
        const fallback = paints.at(-1);
        expect(fallback?.some(value => value > 0)).toBe(true);
        await screen.update(<SessionAvatar session={session(shape)} serverId="home-a" size={24} />);
        expect(paints.at(-1)).not.toEqual(fallback);
        const custom = paints.at(-1);
        await screen.update(<SessionAvatar session={session({ ...shape, fill: ['M5 5 L85 5 L65 85 L25 85 Z'] })} serverId="home-a" size={24} />);
        expect(paints.at(-1)).not.toEqual(custom);
        await screen.update(<SessionAvatar session={session()} serverId="home-a" size={24} />);
        expect(paints.at(-1)).toEqual(fallback);
        await screen.unmount();
    });

    it('draws a Bot its saved face and keeps every other Session on its generic avatar', async () => {
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        const canvas = { createNodeMock: (node: { type: unknown }) => node.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : null };
        type Metadata = ReturnType<typeof createSessionFixture>['metadata'];
        const bot = createSessionFixture({ id: 'bot-docs-gardener', metadata: { path: '/repo', host: 'tester.local', machineId: 'm', bot: { kind: 'bot' },
            botFace: { body: 'crab', palette: 'moss', style: 'pixel' } } as Metadata });
        const face = await renderScreen(<SessionAvatar session={bot} serverId="home-a" size={18} monochrome />, canvas);
        expect(face.findByType(BotFace).props).toMatchObject({ style: 'pixel', size: 18, identity: { body: 'crab', colour: 'moss' } });
        // A sleeping Bot keeps its colour; only generic avatars grey.
        expect(face.findByType(BotFace).props.monochrome).not.toBe(true);
        expect(face.tree.root.findAllByType('Avatar' as never)).toHaveLength(0);
        await face.unmount();

        const ordinary = await renderScreen(<SessionAvatar session={createSessionFixture({ id: 'plain', metadata: { path: '/repo', host: 'tester.local', machineId: 'm' } as Metadata })}
            serverId="home-a" size={18} />, canvas);
        expect(ordinary.tree.root.findAllByType(BotFace)).toHaveLength(0);
        expect(ordinary.tree.root.findAllByType('Avatar' as never)).toHaveLength(1);
        await ordinary.unmount();
    });
});
