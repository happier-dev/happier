// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineRowFixture, createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { StepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { isHomeArrivalMotionPending } from '@/components/hub/homeArrival';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('@/components/atmosphere/glyph/GlyphSurface', () => import('@/components/atmosphere/glyph/GlyphSurface.web'));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@shopify/react-native-skia', async () => {
    const font = {};
    return { ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(), useTypeface: () => font };
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { HomeHub } = await import('./HomeHub');
const { useSessionGettingStartedGuidanceBaseModel } = await import('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { PersonalHomeBootstrapContent, PersonalHomeBootstrapGate, usePersonalHomeBootReadiness } =
    await import('@/components/personalHome/bootstrap/PersonalHomeBootstrapGate');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseRead: (() => void) | undefined;
// RN-web retains its shared observer across cases; keep its recording with that lifetime.
const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
    releaseRead?.();
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await connection?.dispose();
    connection = undefined;
    releaseRead = undefined;
});

function BootReadiness() {
    const readiness = usePersonalHomeBootReadiness();
    return <div data-testid={readiness.active ? 'bootstrap-active' : 'bootstrap-bypassed'} />;
}

function GuidanceObservation(props: Readonly<{ observe: (kind: string) => void }>) {
    const { kind } = useSessionGettingStartedGuidanceBaseModel();
    React.useLayoutEffect(() => props.observe(kind), [kind, props.observe]);
    return null;
}

async function frames(ms: number, observe: () => void) {
    for (let elapsed = 0; elapsed < ms; elapsed += 16) {
        await act(async () => { vi.advanceTimersByTime(16); });
        observe();
    }
}

describe('Home Loading at the RN-web layout boundary', () => {
    it.each([
        { delay: 100, layoutAt: 0, placement: 'corner' as const, coldProfile: false, emptySessions: false },
        { delay: 100, layoutAt: 0, placement: 'corner' as const, coldProfile: false, emptySessions: false, arrival: true },
        { delay: 600, layoutAt: 0, placement: 'corner' as const, coldProfile: false, emptySessions: false },
        { delay: 600, layoutAt: 400, placement: 'corner' as const, coldProfile: false, emptySessions: false },
        { delay: 600, layoutAt: 400, placement: 'side' as const, coldProfile: false, emptySessions: false },
        { delay: 600, layoutAt: 400, placement: 'side' as const, coldProfile: true, emptySessions: false },
        { delay: 600, layoutAt: 0, placement: 'corner' as const, coldProfile: false, emptySessions: true },
    ])(
        'waits $delay ms for the $placement Home layout, receiving positive pane geometry at $layoutAt ms (cold Profile $coldProfile, empty Sessions $emptySessions, first arrival $arrival)', async ({ delay, layoutAt, placement, coldProfile, emptySessions, arrival }) => {
        const machine = createPlainMachineRowFixture({ id: 'loading-dom-machine', accountId: 'loading-dom-account' });
        // This layout test seeds a current list display, not metadata/display backfill.
        const session = createPlainSessionWithDisplayRecordFixture({ id: 'loading-dom-session' });
        const artifact = createHomeHubArtifactHttpBoundary('loading-dom-account', undefined, { machines: [machine] });
        artifact.seed({ v: 1, order: [], hidden: [], items: [] });
        const read = createDeferred<void>();
        const profileRead = createDeferred<void>();
        if (!coldProfile) profileRead.resolve();
        releaseRead = () => { read.resolve(); profileRead.resolve(); };
        let layoutReads = 0;
        connection = await restoreServerAccountForTest({
            serverUrl: `https://home-loading-dom-${placement}-${delay}-${coldProfile}-${emptySessions}-${Boolean(arrival)}.test`, accountId: 'loading-dom-account',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/profile') await profileRead.promise;
                if (path === '/v2/account/settings' && init?.method !== 'POST') return Response.json({ version: 1,
                    content: { t: 'plain', v: { homeAtmosphere: { ...DEFAULT_HOME_ATMOSPHERE,
                        planet: { ...DEFAULT_HOME_ATMOSPHERE.planet, placement } } } } });
                if (path === '/v1/kv') return Response.json({ items: [] });
                if (path === '/v1/machines') return Response.json([machine]);
                if (path === '/v2/sessions/active' || path === '/v2/sessions') return Response.json({ sessions: emptySessions ? [] : [session], next: null, hasNext: false });
                if (path === '/v2/sessions/read-batch') return null;
                if (path === '/v2/sessions/loading-dom-session') return Response.json({ session });
                const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, 'loading-dom-account');
                if (machineResponse) return machineResponse;
                if (path === '/v1/artifacts/read') {
                    const input: unknown = JSON.parse(String(init?.body));
                    if (input && typeof input === 'object' && 'artifactIds' in input && Array.isArray(input.artifactIds)
                        && input.artifactIds.includes(artifact.artifactId)) {
                        layoutReads++;
                        await read.promise;
                        const response = await artifact.request(new URL(`/v1/artifacts/${artifact.artifactId}`, String(url)));
                        return Response.json({ items: [{ artifactId: artifact.artifactId, ok: true, artifact: await response.json() }] });
                    }
                }
                if (path === `/v1/artifacts/${artifact.artifactId}`) {
                    layoutReads++;
                    await read.promise;
                }
                return createEmptyAccountBootstrapHttpResponse(path, init) ?? artifact.request(url, init);
            },
        });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const sessionsReady = () => {
            const index = storage.getState().sessionListIndexByServerId[connection!.serverId];
            expect(emptySessions ? index?.length === 0 : index?.some(row =>
                row.type === 'session' && row.sessionId === session.id)).toBe(true);
            expect(storage.getState().machineListByServerId[connection!.serverId]?.length).toBe(1);
        };
        if (!coldProfile) await vi.waitFor(sessionsReady);

        // jsdom has no layout engine. Supply only OS/browser geometry and observer
        // delivery; real RNW View -> UIManager -> onLayout -> HomeHub stays intact.
        vi.stubGlobal('ResizeObserver', class {
            private record: typeof observers[number];
            constructor(callback: ResizeObserverCallback) { this.record = { callback, targets: new Set() }; observers.push(this.record); }
            observe(target: Element) { this.record.targets.add(target); }
            unobserve(target: Element) { this.record.targets.delete(target); }
            disconnect() { this.record.targets.clear(); }
        });
        let width = layoutAt === 0 ? 800 : 0;
        let height = layoutAt === 0 ? 600 : 0;
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width);
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, height));
        let cloudDraws = 0;
        // jsdom supplies no GPU; the real Still painter targets a recorded 2D canvas.
        vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
        Object.defineProperty(document, 'fonts', { configurable: true, value: { load: async () => [] } });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((function(this: HTMLCanvasElement, kind: string) {
            if (kind !== '2d') return null;
            const image = (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
            return {
                canvas: this,
                setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillText() {}, fillRect() {},
                save() {}, restore() {}, clip() {}, putImageData() {}, createPattern() { return null; },
                getImageData: (_x: number, _y: number, w: number, h: number) => image(w, h), createImageData: image,
                drawImage: () => { if (this.closest('[data-testid="loading-planet.assembly"]')) cloudDraws++; },
            };
        }) as unknown as typeof HTMLCanvasElement.prototype.getContext);
        vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const find = (id: string) => container!.querySelector(`[data-testid="${id}"]`);
        const guidanceKinds: string[] = [];
        const outgoingAnimations: Array<{ onfinish: null | (() => void) }> = [];
        const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
        if (arrival) {
            vi.spyOn(document, 'hasFocus').mockReturnValue(true);
            Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement) {
                const effect = { onfinish: null, cancel() {} };
                outgoingAnimations.push(effect);
                return effect;
            } });
        }
        const observeGuidance = (kind: string) => { guidanceKinds.push(kind); };
        const home = (
            <InjectedAuthProvider credentials={connection!.credentials}>
                <PersonalHomeBootstrapGate isDesktopHost={false} isDesktopMainWindow={false}>
                    <BootReadiness />
                    <GuidanceObservation observe={observeGuidance} />
                    {/* The routed Home sits under the navigator's one Inbox summary (its status line reads it). */}
                    <PersonalHomeBootstrapContent><InboxSummaryProvider><HomeHub /></InboxSummaryProvider></PersonalHomeBootstrapContent>
                </PersonalHomeBootstrapGate>
            </InjectedAuthProvider>
        );
        if (arrival) {
            function Journey() {
                const [signedIn, setSignedIn] = React.useState(false);
                return <StepMotionStage>{signedIn ? home : (
                    <StepMotionLayer layerKey="workflow">
                        <button onClick={() => resolvePostAuthLanding({ replace: () => setSignedIn(true) })}>Approved</button>
                    </StepMotionLayer>
                )}</StepMotionStage>;
            }
            try {
                await act(async () => root!.render(<Journey />));
                await act(async () => container!.querySelector('button')!.click());
                expect(find('home-hub.loading')).toBeTruthy();
                expect(container!.textContent).not.toContain('Approved');
                expect(document.body.textContent).toContain('Approved');
                expect(outgoingAnimations).toHaveLength(0);
                expect(isHomeArrivalMotionPending()).toBe(true);
                await act(async () => read.resolve());
                await flushHookEffects({ cycles: 20, turns: 2 });
                expect(find('home-hub.loading')).toBeNull();
                expect(outgoingAnimations).not.toHaveLength(0);
                await act(async () => {
                    for (const effect of outgoingAnimations) effect.onfinish?.();
                });
                expect(isHomeArrivalMotionPending()).toBe(false);
                expect(document.body.textContent).not.toContain('Approved');
            } finally {
                await act(async () => root!.render(null));
                if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
                else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
            }
            return;
        }
        await act(async () => root!.render(home));
        if (coldProfile) {
            await act(async () => { profileRead.resolve(); });
            await vi.waitFor(sessionsReady);
        }
        if (emptySessions) {
            // The census is real and hydrated, but this mount's credential/daemon
            // scope resolves after its first commit. Unknown cannot mean stopped.
            expect(guidanceKinds[0]).toBe('loading');
            expect(guidanceKinds).not.toContain('start_daemon');
            expect(guidanceKinds.at(-1)).toBe('create_session');
        }
        expect(find('bootstrap-bypassed')).not.toBeNull();
        expect(find('home-hub.loading')).not.toBeNull();
        expect(find('home-unreachable')).toBeNull();
        const deliverLayout = async () => {
            await act(async () => {
                for (const record of observers) record.callback([...record.targets].map(target => ({ target }) as ResizeObserverEntry), {} as ResizeObserver);
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            });
        };
        await deliverLayout();
        expect(layoutReads).toBeGreaterThan(0);
        let assemblyShown = false;
        const observe = () => { assemblyShown ||= find('loading-planet.assembly') !== null; };
        if (layoutAt > 0) {
            await frames(layoutAt, observe);
            expect(assemblyShown).toBe(false);
            expect(cloudDraws).toBe(0);
            width = 800;
            height = 600;
            await deliverLayout();
        }
        await frames(delay - layoutAt, observe);
        expect(assemblyShown).toBe(delay > 250);
        expect(cloudDraws > 0).toBe(delay > 250);
        if (delay > 250) {
            expect(find('loading-planet.assembly')?.querySelector('canvas[style*="visibility: visible"]')?.getAttribute('width')).toBe('800');
            width = 640;
            await deliverLayout();
            await frames(32, observe);
            expect(find('loading-planet.assembly')?.querySelector('canvas[style*="visibility: visible"]')?.getAttribute('width')).toBe('640');
        }
        await act(async () => read.resolve());
        await flushHookEffects({ cycles: 20, turns: 2 });
        await deliverLayout();
        await frames(1600, observe);
        expect(assemblyShown).toBe(delay > 250);
        expect(find('home-hub.loading')).toBeNull();
        expect(find('loading-planet')).toBeNull();
    });
});
