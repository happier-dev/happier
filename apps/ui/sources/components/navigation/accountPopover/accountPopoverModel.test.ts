import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => params
            ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
            : key,
    });
});

import {
    resolveHomeTargetSummary,
    resolveHomeConnectionSummary,
} from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { resolveMachineConnectionSummary } from '@/components/navigation/connectionStatus/resolveMachineConnectionSummary';

import {
    resolveAccountServiceIdentity,
    resolveCurrentHomeHealth,
    resolveLinkCurrentHomeOffer,
    resolveOtherHomeHealth,
} from './accountPopoverModel';

const twoOfThree = { kind: 'multiple', onlineCount: 2, offlineCount: 1 } as const;

describe('account popover Home health', () => {
    it('keeps a connected Home quiet when retained machine presence is unknown', () => {
        const summary = resolveMachineConnectionSummary({ machineCount: 2, onlineCount: 0,
            hasUnknownMachines: true, primaryMachineLabel: null });
        expect(resolveCurrentHomeHealth(resolveHomeConnectionSummary({ healthKind: 'machine_unknown' }), summary))
            .toEqual({ tone: 'ok', label: 'connectionStatus.summary.connected', fix: null });
    });

    it('says how many machines are online for a healthy current Home, with no fix', () => {
        const health = resolveCurrentHomeHealth(resolveHomeConnectionSummary({ healthKind: 'healthy' }), twoOfThree);
        expect(health).toEqual({
            tone: 'ok',
            label: 'accountPopover.machinesOnline(online=2,total=3)',
            fix: null,
        });
    });

    it('says the current Home cannot be reached and offers Retry inline', () => {
        const health = resolveCurrentHomeHealth(
            resolveHomeConnectionSummary({ healthKind: 'server_unreachable' }),
            { kind: 'unknown' },
        );
        expect(health).toEqual({ tone: 'attention', label: 'accountPopover.cantReach', fix: 'retry' });
    });

    it('offers the exact Home recovery, not a retry, when the current Home needs sign-in again', () => {
        const health = resolveCurrentHomeHealth(
            resolveHomeConnectionSummary({ healthKind: 'auth_required' }),
            { kind: 'unknown' },
        );
        expect(health).toMatchObject({ tone: 'attention', fix: 'restore' });
    });

    it('does not offer a retry the error owner says cannot help', () => {
        const health = resolveCurrentHomeHealth(
            resolveHomeConnectionSummary({ healthKind: 'server_error', syncErrorKind: 'server', syncErrorRetryable: false }),
            { kind: 'unknown' },
        );
        expect(health.fix).toBeNull();
    });

    it('keeps the retry the summary owner offers for a connected Home whose last sync failed', () => {
        const health = resolveCurrentHomeHealth(
            resolveHomeConnectionSummary({ healthKind: 'healthy', syncErrorKind: 'network', syncErrorRetryable: true }),
            twoOfThree,
        );
        expect(health).toEqual({ tone: 'ok', label: 'accountPopover.machinesOnline(online=2,total=3)', fix: 'retry' });
    });

    it('never pairs a healthy dot with no machine online: the dot and the line state the same fact', () => {
        const connected = resolveHomeConnectionSummary({ healthKind: 'machine_offline' });
        const offline = { tone: 'neutral', label: 'accountPopover.connectedNoMachinesOnline', fix: null };
        expect(resolveCurrentHomeHealth(connected, { kind: 'multiple', onlineCount: 0, offlineCount: 2 })).toEqual(offline);
        expect(resolveCurrentHomeHealth(connected, { kind: 'single', label: 'mbp', online: false })).toEqual(offline);
        // Some online: healthy, and says how many.
        expect(resolveCurrentHomeHealth(connected, { kind: 'multiple', onlineCount: 1, offlineCount: 1 }).tone).toBe('ok');
    });

    it('keeps a connected current Home quiet about machines it has not seen yet', () => {
        expect(resolveCurrentHomeHealth(resolveHomeConnectionSummary({ healthKind: 'healthy' }), { kind: 'unknown' }))
            .toEqual({ tone: 'ok', label: 'connectionStatus.summary.connected', fix: null });
        expect(resolveCurrentHomeHealth(resolveHomeConnectionSummary({ healthKind: 'no_machine' }), { kind: 'none' }))
            .toEqual({ tone: 'neutral', label: 'accountPopover.noMachines', fix: null });
    });

    it('shows reconnecting as pending, keeping the retry the summary owner offers', () => {
        expect(resolveCurrentHomeHealth(resolveHomeConnectionSummary({ healthKind: 'connecting' }), twoOfThree))
            .toEqual({ tone: 'pending', label: 'connectionStatus.summary.reconnecting', fix: 'retry' });
    });

    it('says another Home is signed out and offers Sign in inline', () => {
        const health = resolveOtherHomeHealth(resolveHomeTargetSummary({ authStatus: 'signedOut' }));
        expect(health).toEqual({ tone: 'off', label: 'accountPopover.signedOut', fix: 'sign_in' });
    });

    it('says another Home is connected, quietly', () => {
        expect(resolveOtherHomeHealth(resolveHomeTargetSummary({ authStatus: 'signedIn', projectionStatus: 'idle' })))
            .toEqual({ tone: 'ok', label: 'connectionStatus.summary.connected', fix: null });
    });

    it('says another Home cannot be reached without offering a retry it cannot run', () => {
        expect(resolveOtherHomeHealth(resolveHomeTargetSummary({ authStatus: 'signedIn', projectionStatus: 'error' })))
            .toEqual({ tone: 'attention', label: 'accountPopover.cantReach', fix: null });
    });
});

describe('account popover identity', () => {
    it('names the account service the person is signed in to', () => {
        expect(resolveAccountServiceIdentity({ entryStatus: 'ready', credentialReadKind: 'valid', serviceName: 'Acme', selfService: false, policyReady: true }))
            .toEqual({ kind: 'signed_in', serviceName: 'Acme', canOpenAccount: true });
    });

    it('says the person is not linked to the configured service, never a hard-coded one', () => {
        expect(resolveAccountServiceIdentity({ entryStatus: 'ready', credentialReadKind: 'absent', serviceName: 'Acme', selfService: false, policyReady: true }))
            .toEqual({ kind: 'not_linked', serviceName: 'Acme', canOpenAccount: true });
    });

    it('explains an unreachable or unsupported service and offers nothing it cannot open', () => {
        expect(resolveAccountServiceIdentity({ entryStatus: 'unavailable', credentialReadKind: 'absent', serviceName: 'Acme', selfService: false, policyReady: true }))
            .toEqual({ kind: 'unavailable', serviceName: 'Acme', canOpenAccount: false });
        expect(resolveAccountServiceIdentity({ entryStatus: 'unsupported', credentialReadKind: 'absent', serviceName: 'Acme', selfService: false, policyReady: true }))
            .toEqual({ kind: 'unsupported', serviceName: 'Acme', canOpenAccount: false });
        expect(resolveAccountServiceIdentity({ entryStatus: 'loading', credentialReadKind: 'absent', serviceName: 'Acme', selfService: false, policyReady: true }))
            .toEqual({ kind: 'loading', serviceName: 'Acme', canOpenAccount: false });
    });

    it('says a Home that is its own sign-in service is signed in, never "not linked"', () => {
        // The Home is the service: the person is in it, and linking the Home to itself does not apply.
        expect(resolveAccountServiceIdentity({ entryStatus: 'ready', credentialReadKind: 'absent', serviceName: 'Personal Home', selfService: true, policyReady: true }))
            .toEqual({ kind: 'self', serviceName: 'Personal Home', canOpenAccount: true });
        expect(resolveAccountServiceIdentity({ entryStatus: 'unavailable', credentialReadKind: 'absent', serviceName: 'Personal Home', selfService: true, policyReady: true }))
            .toEqual({ kind: 'self', serviceName: 'Personal Home', canOpenAccount: false });
    });

    it('always has a service line: a Home that offers no service is signed in, one not read yet is pending', () => {
        expect(resolveAccountServiceIdentity({ entryStatus: 'not_offered', credentialReadKind: 'absent', serviceName: null, selfService: false, policyReady: true }))
            .toEqual({ kind: 'no_service', canOpenAccount: false });
        expect(resolveAccountServiceIdentity({ entryStatus: 'not_offered', credentialReadKind: 'absent', serviceName: null, selfService: false, policyReady: false }))
            .toEqual({ kind: 'pending', canOpenAccount: false });
    });

    it('settles instead of "checking" forever once the policy read failed or the Home does not answer', () => {
        expect(resolveAccountServiceIdentity({ entryStatus: 'not_offered', credentialReadKind: 'absent', serviceName: null, selfService: false, policyReady: false, policyUnavailable: true }))
            .toEqual({ kind: 'status_unavailable', canOpenAccount: false });
    });
});

describe('account popover link offer', () => {
    const base = {
        serviceReady: true,
        selfService: false,
        currentHomeServerIdentityId: 'srv_home',
        signedIn: false,
        directoryReady: false,
        currentHomeIsLinked: false,
    };

    it('offers linking the exact current Home to the service when the person is not signed in', () => {
        expect(resolveLinkCurrentHomeOffer(base)).toEqual({ kind: 'link_service', homeServerIdentityId: 'srv_home' });
    });

    it('offers making this Home available when signed in but the Home is not linked yet', () => {
        expect(resolveLinkCurrentHomeOffer({ ...base, signedIn: true, directoryReady: true }))
            .toEqual({ kind: 'make_available', homeServerIdentityId: 'srv_home' });
    });

    it('offers no link when the Home is its own sign-in service', () => {
        expect(resolveLinkCurrentHomeOffer({ ...base, selfService: true })).toBeNull();
    });

    it('offers nothing once the current Home is linked, or when there is nothing to link', () => {
        expect(resolveLinkCurrentHomeOffer({ ...base, signedIn: true, directoryReady: true, currentHomeIsLinked: true })).toBeNull();
        expect(resolveLinkCurrentHomeOffer({ ...base, currentHomeServerIdentityId: null })).toBeNull();
        expect(resolveLinkCurrentHomeOffer({ ...base, serviceReady: false })).toBeNull();
    });
});
