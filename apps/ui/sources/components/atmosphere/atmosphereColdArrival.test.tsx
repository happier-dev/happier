import 'fake-indexeddb/auto';
import Color from 'color';
import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, createSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { AtmosphereSurfaceFrame } from './AtmosphereSurfaceFrame';
import { AtmosphereLayer } from './AtmosphereLayer';
import { atmosphereStageStore } from './atmosphereStage';
import { pictureStore } from './pictureStore';
import { AppShellMaterialPlane } from '@/components/navigation/shell/appShellMaterialPlane';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { readBrowserMaterialVariables, resolveBrowserMaterialPaint } from '@/dev/testkit/glassBackdrop';
import type { BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';

// Real store, membership, stage and drawing orchestration; only platform boundaries are adapted.
vi.mock('./pictureStore', async () => import('./pictureStore.web'));
vi.mock('./BackdropCanvas', async () => import('./BackdropCanvas.web'));
vi.mock('./WallpaperHaze', async () => import('./WallpaperHaze.web'));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('paints only the late Project picture on cold Session arrival, then follows explicit Home inheritance', async () => {
    const previous = storage.getState();
    const scope = { serverId: 'cold-project-home', accountId: 'cold-project-account' };
    const project = { serverId: scope.serverId, projectKey: 'cold-project' };
    const session = createSessionFixture({ id: 'cold-project-session', serverId: scope.serverId,
        ownerAccountId: scope.accountId, projectKey: project.projectKey });
    const homePicture = ATMOSPHERE_PICTURES.find(picture => picture.id === 'snowy-alps')!;
    const projectPicture = ATMOSPHERE_PICTURES.find(picture => picture.id === 'valley-lakes')!;
    const ids = [homePicture, projectPicture].map(picture => 'builtin:' + picture.id);
    const requests: BackdropRenderRequest[] = [];
    const replies: (() => void)[] = [];
    // The physical worker dispatches one raster at a time; answering it admits the queued haze.
    const answerNext = async () => {
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        await act(async () => replies.shift()!());
    };
    const painted: string[] = [];
    let geometryReady = false;
    const measurements: (() => void)[] = [];
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            requests.push(message.request);
            const { width: w, height: h, source } = message.request;
            const value = 'localId' in source && source.localId === ids[1] ? 2 : 1;
            replies.push(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { w, h, rgba: new Uint8ClampedArray(w * h * 4).fill(value) } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const fetch = vi.spyOn(globalThis, 'fetch');
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        for (const picture of [homePicture, projectPicture]) await pictureStore.put({ localId: 'builtin:' + picture.id,
            kind: 'builtin', data: new Blob(['cached ' + picture.id]), source: picture.src });
        storage.setState(state => ({ settingsScope: scope, profileScope: scope, projectAccountRows: null,
            sessionListRowsByServerId: {}, settings: { ...state.settings, homeAtmosphere: {
                ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', showOn: ['sessions'],
                moments: { ...DEFAULT_HOME_ATMOSPHERE.moments, idleResettle: false },
                picture: { ref: { kind: 'builtin', id: homePicture.id }, layout: 'wallpaper' },
            } } }));
        const surface = { session: { serverId: scope.serverId, sessionId: session.id } };
        transaction.mockClear();
        screen = await renderScreen(<View><AtmosphereLayer sheetRadius={12} chrome={false} />
            <AppShellMaterialPlane testID="session-plane" group="content" color="#fff" translucentColor="#fff" style={{ flex: 1 }}>
            <AtmosphereSurfaceFrame surface={surface} session focused visible><>Session loading</></AtmosphereSurfaceFrame>
            </AppShellMaterialPlane>
        </View>, { createNodeMock: element => element.type === 'canvas'
            ? { getContext: () => ({ putImageData(image: ImageData) { painted.push(image.data[0] === 2 ? ids[1]! : ids[0]!); } }) }
            : { measureInWindow(done: (x: number, y: number, w: number, h: number) => void) {
                const measured = () => done(0, 0, 80, 60);
                if (geometryReady) measured(); else measurements.push(measured);
            } } });
        // Unknown membership is not evidence to display Home, nor demand its picture bytes.
        const plane = screen.findHostByTestId('session-plane')!;
        const backing = plane.findAll(node => typeof node.type === 'string' && node.props.dataSet?.happyGlassBackdrop === 'true')[0]!;
        const paint = () => resolveBrowserMaterialPaint(flattenTestStyle(backing.props.style).backgroundColor as string,
            readBrowserMaterialVariables(backing));
        expect(Color(paint()).alpha()).toBe(1);
        expect(transaction).not.toHaveBeenCalled();
        await act(async () => {
            storage.getState().applyServerScopedSessionListRows(scope.serverId,
                [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
            storage.getState().activateProjectAccountRowsScope(scope);
        });
        expect(transaction).not.toHaveBeenCalled();
        const rows = { scope, status: 'ready' as const, coverage: 'partial' as const, workspaceRefs: [], relationships: [],
            organizations: [], revisionsByPhysicalKey: {} };
        await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope, rows); });
        expect(transaction).not.toHaveBeenCalled();
        const organization = { key: { kind: 'project-organization' as const, ...project }, revision: 1,
            value: { atmosphere: { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const, showOn: ['sessions'] as 'sessions'[],
                picture: { ref: { kind: 'builtin' as const, id: projectPicture.id }, layout: 'wallpaper' as const } } } };
        await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope,
            { ...rows, coverage: 'complete', organizations: [organization] }); });
        await vi.waitFor(() => expect(atmosphereStageStore.get().stage?.surface).toEqual(surface));
        expect(requests).toHaveLength(0); // Geometry, independently of admitted bytes, gates rendering.
        await act(async () => { geometryReady = true; measurements.splice(0).forEach(measured => measured()); });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        expect(painted).toHaveLength(0);
        expect(atmosphereStageStore.get().pictureShown).toBe(false);
        await answerNext();
        await answerNext();
        expect(requests).toHaveLength(2); // Full picture + one shared quarter-size haze.
        expect(painted).toEqual([ids[1], ids[1], ids[1]]);
        expect(atmosphereStageStore.get().pictureShown).toBe(true);
        expect(screen.findHostByTestId('session-plane')).toBe(plane);
        expect(requests.every(request => 'localId' in request.source && request.source.localId === ids[1])).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        // A deliberate inheritance update still reaches the same mounted Session and physical renderer.
        await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope,
            { ...rows, coverage: 'complete', organizations: [{ ...organization, revision: 2, value: { atmosphere: 'home' } }] }); });
        await answerNext();
        await answerNext();
        expect(requests).toHaveLength(4);
        expect(painted.slice(-3)).toEqual([ids[0], ids[0], ids[0]]);
        const transactions = transaction.mock.calls.length;
        await act(async () => { storage.setState(state => ({ settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut } })); });
        expect(transaction).toHaveBeenCalledTimes(transactions);
        expect(requests).toHaveLength(4);
    } finally {
        await screen?.unmount();
        storage.setState(previous, true);
        transaction.mockRestore(); fetch.mockRestore();
        for (const id of ids) await pictureStore.remove(id);
    }
});
