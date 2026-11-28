import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountPlanResponseV1 } from '@happier-dev/protocol';

import { config } from '@/config';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { resetAccountPlanResourceForTests } from '@/sync/domains/plans/accountPlanResource';
import { HAPPIER_CLOUD_SERVER_URL } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

const server = vi.hoisted(() => ({ supporter: false, planReads: 0, respond: null as null | (() => unknown) }));
const modal = vi.hoisted(() => ({ current: null as ReturnType<typeof createModalModuleMock> | null }));
// The `expo-alternate-app-icons` native module, as a binary built with it reports it.
const native = vi.hoisted(() => ({
    name: null as string | null,
    calls: [] as (string | null)[],
}));

// The plan route over the network (sync/api is the transport adapter); the plan resource is real.
vi.mock('@/sync/api/account/apiAccountPlan', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchAccountPlan: async () => {
        server.planReads += 1;
        return { kind: 'ok', plan: server.respond!() };
    },
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock: create } = await import('@/dev/testkit/mocks/modal');
    modal.current = create();
    return modal.current.module;
});
vi.mock('expo-modules-core', async () => ({
    ...(await import('@/dev/expoModulesCoreStub')),
    requireOptionalNativeModule: (name: string) => name === 'ExpoAlternateAppIcons'
        ? {
            supportsAlternateIcons: true,
            getAppIconName: () => native.name,
            setAlternateAppIcon: async (next: string | null) => {
                native.calls.push(next);
                native.name = next;
                return next;
            },
        }
        : null,
}));
// The server's feature payload: the Supporter offer exists on this server.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => ({ featureId, state: featureId === 'supporter' ? 'enabled' : 'disabled' }),
}));
// The Supporter sheet's QR code reaches the camera module, which does not parse under Node.
vi.mock('@/components/qr', () => ({ QRCode: () => null }));
// Bundled PNG assets cannot load under Node; the tile owner's artwork is not under test.
vi.mock('./AppIconTile', () => ({ AppIconTile: () => null }));

function planResponse(active: boolean): AccountPlanResponseV1 {
    const limits = { sessionRetentionDays: 60, subagentRetentionDays: 7, toolOutputRetentionDays: null, pinnedSessions: 50, artifactStorageBytes: null };
    return {
        plan: null,
        limits,
        usage: { pinnedSessions: 0, artifactStorageBytes: null },
        supporter: { active, since: active ? 1 : null, number: active ? 42 : null, recurringSince: null },
        supporterRing: false,
        offers: {
            plans: [],
            baseLimits: limits,
            graceDays: 90,
            teams: null,
            supporter: {
                suggestedMonthlyMinor: 500,
                minimumMinor: 300,
                currency: 'usd',
                presets: { monthly: [300, 500], once: [1000] },
                storeOfferingId: 'supporter',
            },
            portalUrl: null,
            billingReference: 'account',
        },
    };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
type Node = { props: Record<string, unknown> };
type Root = { findAll: (predicate: (node: Node) => boolean) => Node[] };
const tile = (root: Root, id: string) =>
    root.findAll((node) => node.props.testID === `settings-app-icon:${id}` && typeof node.props.onPress === 'function')[0]!;
const press = (root: Root, id: string) => act(async () => {
    (tile(root, id).props.onPress as () => void)();
});

describe('AppIconScreen', () => {
    const platformOS = Platform.OS;
    const appleKey = config.revenueCatAppleKey;

    beforeEach(() => {
        // A store build: the Supporter offer is bought in the App Store sheet.
        (config as { revenueCatAppleKey?: string }).revenueCatAppleKey = 'appl_test';
        Platform.OS = 'ios';
        resetAccountPlanResourceForTests();
        upsertAndActivateServer({ serverUrl: HAPPIER_CLOUD_SERVER_URL });
        server.planReads = 0;
        server.respond = () => planResponse(server.supporter);
        modal.current?.spies.show.mockClear();
        native.name = null;
        native.calls = [];
    });

    afterEach(() => {
        Platform.OS = platformOS;
        (config as { revenueCatAppleKey?: string }).revenueCatAppleKey = appleKey;
    });

    it('opens the Supporter sheet from a locked icon and applies a free one on this device only', async () => {
        server.supporter = false;
        const { AppIconScreen } = await import('./AppIconScreen');
        const screen = await renderScreen(<AppIconScreen />);
        await flush();
        const root = screen.root as never as Root;
        // Not held yet on this device: opening the page reads the plan once.
        expect(server.planReads).toBe(1);
        expect(tile(root, 'default').props.accessibilityState).toMatchObject({ selected: true });
        expect(tile(root, 'gold').props.accessibilityLabel).toMatch(/Supporter|supporterTag/);

        await press(root, 'gold');
        await flush();
        const shown = modal.current!.spies.show.mock.calls.at(-1)?.[0] as { props?: { offer?: unknown } } | undefined;
        expect(shown?.props?.offer).toMatchObject({ minimumMinor: 300 });
        expect(native.calls).toEqual([]);

        await press(root, 'night');
        await flush();
        expect(native.calls).toEqual(['Night']);
        expect(tile(root, 'night').props.accessibilityState).toMatchObject({ selected: true });
        // Picking is device-local: no server call beyond the page's one plan read.
        expect(server.planReads).toBe(1);
    });

    it('gives a supporter all eight icons', async () => {
        server.supporter = true;
        const { AppIconScreen } = await import('./AppIconScreen');
        const screen = await renderScreen(<AppIconScreen />);
        await flush();
        const root = screen.root as never as Root;

        await press(root, 'aurora');
        await flush();
        expect(native.calls).toEqual(['Aurora']);
        expect(modal.current!.spies.show).not.toHaveBeenCalled();
    });
});
