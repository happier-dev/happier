// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout, type WebLayoutMeasurement } from '@/dev/testkit/render/measureWebLayout';
import { t } from '@/text';

/**
 * A Computer state that is not a picture, drawn in the floating viewer's body at the size the frame
 * gives it before the source reports a picture, as a browser lays it out: its heading and its way
 * forward are inside the visible body, never clipped by the picture's aspect box (QA-COMP2 OG-1).
 */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

type State = 'permission' | 'not-shared';

// Locate the permission state's current heading; this suite owns geometry, not its prose.
const PERMISSION_HEADING = t('computerUse.permission.title', { machine: 'MacBook Pro' });
const NOT_SHARED_ACTION = 'Choose a window';

/** The frame's body at `width` before the source reports a picture: `minBody` is what the source asked for. */
async function measureBody(state: State, width: number, bodyHeight?: number): Promise<WebLayoutMeasurement> {
    const { ComputerScreenViewer } = await import('./ComputerScreenViewer');
    const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
    const { resolveSessionViewerBodyAspect, SESSION_VIEWER_PERMISSION_MIN_BODY } = await import('@/components/sessions/viewer/sessionViewerGeometry');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const height = bodyHeight ?? Math.round(width / resolveSessionViewerBodyAspect(
        null, width, state === 'permission' ? SESSION_VIEWER_PERMISSION_MIN_BODY : undefined));
    const noop = () => {};
    await act(async () => {
        root!.render(
            <View testID="body" style={{ width, height, overflow: 'hidden' }}>
                <SurfaceStateSizeProvider size="pane">
                    <ComputerScreenViewer
                        testID="v"
                        chrome="none"
                        agent={{ agentId: null, name: 'Claude' }}
                        targetTitle={state === 'permission' ? 'Safari' : null}
                        targetKind="window"
                        machineName="MacBook Pro"
                        shared={state === 'permission'}
                        stream={null}
                        presence={{ kind: 'agent', activity: null, target: null, controlEpoch: 0 }}
                        agentActing={false}
                        grants={state === 'permission' ? { capture: 'denied', input: 'granted' } : null}
                        openSettings="idle"
                        onOpenSettings={noop}
                        onTakeControl={(async () => ({ status: 'taken' })) as never}
                        onHandBack={noop}
                        onCheckAgain={noop}
                        onChooseWindow={noop}
                        onStopSharing={noop}
                    />
                </SurfaceStateSizeProvider>
            </View>,
        );
    });
    return measureWebLayout(host, {
        viewport: { width: Math.max(width, 390), height: 900 },
        texts: [PERMISSION_HEADING, NOT_SHARED_ACTION],
        settle: (replay) => act(replay),
        ...(process.env.HAPPIER_TEST_WEB_LAYOUT_ARTIFACT_DIR ? {
            screenshotPath: `${process.env.HAPPIER_TEST_WEB_LAYOUT_ARTIFACT_DIR}/body-${state}-${width}x${height}.png`,
        } : {}),
    });
}

describe('a Computer state that is not a picture, in the floating viewer body', () => {
    it.each([432, 358])('shows the permission heading and both actions inside the body the frame gives it (%s px)', async (width) => {
        const layout = await measureBody('permission', width);
        const body = layout.rect('body');
        const heading = layout.textRects(PERMISSION_HEADING)[0]!;
        expect(heading.top).toBeGreaterThanOrEqual(body.top);
        expect(heading.bottom).toBeLessThanOrEqual(body.bottom);
        for (const id of ['v-permission-card-open-settings', 'v-permission-card-check-again']) {
            const action = layout.rect(id);
            expect(action.top).toBeGreaterThanOrEqual(body.top);
            expect(action.bottom).toBeLessThanOrEqual(body.bottom);
        }
    });

    it('reads from its top, scrolling, when the body is shorter than the card', async () => {
        const layout = await measureBody('permission', 432, 272);
        const body = layout.rect('body');
        expect(layout.textRects(PERMISSION_HEADING)[0]!.top).toBeGreaterThanOrEqual(body.top);
        // `clipped`: the stage holds more than its box shows, which is a scroll, not a cut.
        expect(layout.rect('v-permission').clipped).toBe(true);
    });

    it('keeps a short state centred in the default body', async () => {
        const layout = await measureBody('not-shared', 432);
        const body = layout.rect('body');
        const action = layout.textRects(NOT_SHARED_ACTION)[0]!;
        expect(action.top).toBeGreaterThanOrEqual(body.top);
        expect(action.bottom).toBeLessThanOrEqual(body.bottom);
    });
});
