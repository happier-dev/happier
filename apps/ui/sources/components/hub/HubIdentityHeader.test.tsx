import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSettingsViewCommonModuleMocks } from '../settings/settingsViewTestHelpers';

// Imported from their own testkit modules rather than the `@/dev/testkit` barrel: see
// `HomeAdministrationPeopleScreen.test.tsx` for why the barrel would bind the real transports first.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machines = vi.hoisted(() => ({ value: [] as unknown[] }));

installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return { ...actual, useAllMachines: () => machines.value };
    },
});

// Only the network and the device credential store are replaced; the Home binding, engine and
// governance store below the header are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { HubIdentityHeader } = await import('./HubIdentityHeader');

const GOVERNANCE_PATH = '/v1/home/governance/get';

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    machines.value = [{ id: 'm1' }, { id: 'm2' }];
});

afterEach(() => {
    standardCleanup();
    machines.value = [];
});

async function renderHeader() {
    return renderScreen(<HubIdentityHeader />);
}

describe('HubIdentityHeader', () => {
    it.each(['valid', 'absent'] as const)('describes a settled %s Account Service credential read', async (kind) => {
        await checkStoredSignIn(kind, kind === 'valid' ? 'settingsOverview.accountServiceSignedIn' : 'accountPopover.notLinkedTo');
    });

    it.each(['corrupt', 'unavailable'] as const)('does not claim Not Linked when Account Service credentials are %s', async (kind) => {
        await checkStoredSignIn(kind, 'accountPopover.signInStatusUnavailable');
    });

    it('says which Home this is and the viewer\'s role in it, not a machine count', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada' });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        const screen = await renderHeader();

        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-overview-role')).toBeTruthy());
        expect(screen.getTextContent()).toContain('homeGovernance.roleOwner');
        expect(screen.findByTestId('settings-overview-home')).toBeTruthy();
        expect(screen.findByTestId('settings-overview-machines')).toBeNull();
    });

    it('never waits on a Home that does not answer: the header shows without a role', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada' });
        harness.answer(home, GOVERNANCE_PATH, { status: 503, body: { error: 'unavailable' } });
        const screen = await renderHeader();

        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-overview-home')).toBeTruthy());
        expect(screen.findByTestId('settings-overview-role')).toBeNull();
    });
});

async function checkStoredSignIn(kind: 'valid' | 'absent' | 'corrupt' | 'unavailable', expected: string) {
    const deviceStorage = installLocalStorageMock();
    const fixture = createDirectoryHttpFixture();
    const { TokenStorage, ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY } = await import('@/auth/storage/tokenStorage');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const target = { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId };
    try {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada' });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        const features = createRootLayoutFeaturesResponse({ signInService: {
            v: 1, mode: 'external', endpoint: target.endpoint, expectedServerIdentityId: target.serverIdentityId,
        } });
        primeServerFeaturesSnapshot({ serverId: home, snapshot: { status: 'ready', features } });
        harness.answer(home, '/v1/features', { body: features });
        setRuntimeFetch((input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            return url.origin === target.endpoint
                ? fixture.request(url.origin, `${url.pathname}${url.search}`, init)
                : harness.request(input, init);
        });
        expect(await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: fixture.token })).toBe(true);
        const storageKey = [...deviceStorage.store.keys()].find((key) => key.includes(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY));
        if (!storageKey) throw new Error('Expected Account Service credential storage');
        if (kind === 'absent') expect(await TokenStorage.accountDirectoryAuthCredentials.remove(target)).toBe(true);
        if (kind === 'corrupt') deviceStorage.store.set(storageKey, '{invalid-json');
        if (kind === 'unavailable') deviceStorage.getItemMock.mockImplementation((key) => {
            if (key === storageKey) throw new Error('Device credential storage unavailable');
            return deviceStorage.store.get(key) ?? null;
        });
        expect((await TokenStorage.accountDirectoryAuthCredentials.read(target)).kind).toBe(kind);
        const screen = await renderHeader();
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-overview-account-service')).toBeTruthy());
        expect(screen.getTextContent()).toContain(expected);
        expect(screen.getTextContent()).not.toContain(kind === 'valid' ? 'accountPopover.notLinkedTo' : 'settingsOverview.accountServiceSignedIn');
        if (kind === 'corrupt' || kind === 'unavailable') expect(screen.getTextContent()).not.toContain('accountPopover.notLinkedTo');
        if (kind === 'corrupt' || kind === 'unavailable') {
            deviceStorage.getItemMock.mockImplementation((key) => deviceStorage.store.get(key) ?? null);
            deviceStorage.store.delete(storageKey);
            await act(async () => {
                expect(await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: fixture.token })).toBe(true);
            });
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('settingsOverview.accountServiceSignedIn'));
            expect(screen.getTextContent()).not.toContain('accountPopover.signInStatusUnavailable');
        }
    } finally {
        standardCleanup();
        deviceStorage.restore();
        setRuntimeFetch(harness.request);
    }
}
