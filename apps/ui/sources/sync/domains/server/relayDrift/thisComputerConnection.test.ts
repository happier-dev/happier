import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import-time defaults (Account service, Cloud identity) also model an unconfigured source build.
vi.hoisted(() => vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', ''));
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import {
    projectThisComputerServiceRowsForApp,
    readThisComputerServiceRows,
    resolveThisComputerConnection,
} from './thisComputerConnection';

const healthyDaemon = {
    serviceInstalled: true,
    daemonRunning: true,
    needsAuth: false,
    daemonServerUrl: 'https://relay.example.test',
    daemonAccountId: 'acct_app',
    daemonAccountLabel: null,
} as const;

describe('resolveThisComputerConnection', () => {
    beforeEach(async () => {
        // Studio is the only saved Home, as in an unconfigured source build.
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', '');
        await upsertServerProfile({ serverUrl: healthyDaemon.daemonServerUrl, name: 'Studio' });
    });
    afterEach(() => { vi.unstubAllEnvs(); });
    it('names both accounts when this computer serves the same Home as somebody else', () => {
        expect(resolveThisComputerConnection({
            daemon: { ...healthyDaemon, daemonAccountId: 'acct_other_1234567890', daemonAccountLabel: 'robin' },
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: 'Leeroy',
        })).toEqual({
            status: 'daemon_account_mismatch',
            homeLabel: 'Studio',
            daemonHomeLabel: 'Studio',
            appAccountLabel: 'Leeroy',
            daemonAccountLabel: 'robin',
        });
    });

    it('names unnamed people neutrally and the viewer as their own account, never by an id', () => {
        const connection = resolveThisComputerConnection({
            daemon: { ...healthyDaemon, daemonAccountId: 'acct_other_1234567890' },
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: null,
        });
        expect(connection?.daemonAccountLabel).toBe(t('accountDisplay.unnamed'));
        expect(connection?.appAccountLabel).toBe(t('accountDisplay.yours'));
        const self = resolveThisComputerConnection({
            daemon: healthyDaemon,
            activeRelayUrl: healthyDaemon.daemonServerUrl,
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: 'Leeroy',
        });
        expect(self?.daemonAccountLabel).toBe('Leeroy');
        expect(resolveThisComputerConnection({
            daemon: { ...healthyDaemon, daemonAccountId: null },
            activeRelayUrl: healthyDaemon.daemonServerUrl,
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: null,
        })?.daemonAccountLabel).toBeNull();
    });

    it('is aligned for this account on this Home, and absent without a daemon or a status read', () => {
        expect(resolveThisComputerConnection({
            daemon: healthyDaemon,
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: 'Leeroy',
        })?.status).toBe('aligned');

        expect(resolveThisComputerConnection({
            daemon: { ...healthyDaemon, serviceInstalled: false, daemonRunning: false },
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: 'Leeroy',
        })).toBeNull();

        expect(resolveThisComputerConnection({
            daemon: null,
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: 'Leeroy',
        })).toBeNull();
    });

    it('names the other Home when the daemon serves a different relay', () => {
        expect(resolveThisComputerConnection({
            daemon: { ...healthyDaemon, daemonServerUrl: 'https://other-home.example.test', daemonAccountId: 'acct_other_home' },
            activeRelayUrl: 'http://127.0.0.1:3012',
            activeLocalRelayUrl: null,
            appAccountId: 'acct_app',
            appAccountLabel: 'Leeroy',
        })).toMatchObject({
            status: 'daemon_url_mismatch',
            homeLabel: t('settingsAccount.thisHomeTitle'),
            daemonHomeLabel: t('settingsAccount.thisHomeTitle'),
        });
    });
});

describe('projectThisComputerServiceRowsForApp — the tray\'s rows (R16 c)', () => {
    const row = (relayUrl: string, extra: Record<string, unknown> = {}) => ({
        relayUrl,
        state: 'connected',
        appManaged: true,
        serviceTargetMode: 'pinned',
        actions: ['restart', 'stop'],
        ...extra,
    });
    const appHome = { activeRelayUrl: 'https://relay.example.test', activeLocalRelayUrl: null, appAccountId: 'acct_app' } as const;

    it('reads the executor rows as they are and drops malformed ones', () => {
        expect(readThisComputerServiceRows([
            row('https://relay.example.test'),
            row('https://company.example.test', { state: 'offline', appManaged: false, actions: [] }),
            row('', {}),
            { relayUrl: 'https://bogus.example.test', state: 'sideways', appManaged: true, actions: [] },
            row('https://mixed.example.test', { actions: ['stop', 'reinstall'], serviceTargetMode: 'default-following' }),
        ])).toEqual([
            row('https://relay.example.test'),
            row('https://company.example.test', { state: 'offline', appManaged: false, actions: [] }),
            row('https://mixed.example.test', { actions: ['stop'], serviceTargetMode: 'default-following' }),
        ]);
        expect(readThisComputerServiceRows(undefined)).toBeNull();
        expect(readThisComputerServiceRows({ rows: [] })).toBeNull();
    });

    it('is pending before any status read, and failed when the read carried no rows', () => {
        expect(projectThisComputerServiceRowsForApp({ status: null, ...appHome })).toEqual({ status: 'pending' });
        expect(projectThisComputerServiceRowsForApp({
            status: { ...healthyDaemon, serviceRows: null, serviceRowsComplete: true },
            ...appHome,
        })).toEqual({ status: 'failed' });
    });

    it('keeps other Homes as reported and re-judges only the app\'s own Home against the app\'s account', () => {
        const rows = [
            row('https://relay.example.test'),
            row('https://company.example.test', { state: 'offline', actions: ['start'] }),
        ];
        expect(projectThisComputerServiceRowsForApp({
            // The daemon serving the app's Home is signed in to another account: the executor cannot
            // know which account the app is on, the app can.
            status: { ...healthyDaemon, daemonAccountId: 'acct_other', serviceRows: readThisComputerServiceRows(rows), serviceRowsComplete: false },
            ...appHome,
        })).toEqual({
            status: 'listed',
            complete: false,
            rows: [
                { ...row('https://relay.example.test'), state: 'needs_attention' },
                row('https://company.example.test', { state: 'offline', actions: ['start'] }),
            ],
        });
    });

    it('keeps the app Home in attention when its daemon reports no relay', () => {
        const rows = readThisComputerServiceRows([row('https://relay.example.test')]);
        expect(projectThisComputerServiceRowsForApp({
            status: { ...healthyDaemon, daemonServerUrl: null, serviceRows: rows, serviceRowsComplete: true },
            ...appHome,
        })).toMatchObject({ status: 'listed', rows: [{ state: 'needs_attention' }] });
    });
});

describe('projectThisComputerServiceRowsForApp — known sessions (A13-07)', () => {
    const managed = (relayUrl: string) => ({ relayUrl, state: 'connected', appManaged: true, serviceTargetMode: 'pinned', actions: ['stop'] });

    it('carries the app Home\'s session count when the app can see it, and claims none for other Homes or when unseen', () => {
        const status = { ...healthyDaemon, serviceRows: readThisComputerServiceRows([managed('https://relay.example.test'), managed('https://company.example.test')]), serviceRowsComplete: true };
        const seen = projectThisComputerServiceRowsForApp({
            status, activeRelayUrl: 'https://relay.example.test', activeLocalRelayUrl: null, appAccountId: 'acct_app', appHomeActiveSessionCount: 0,
        });
        expect(seen.status === 'listed' && seen.rows.map((row) => row.activeSessionCount)).toEqual([0, undefined]);
        const unseen = projectThisComputerServiceRowsForApp({
            status, activeRelayUrl: 'https://relay.example.test', activeLocalRelayUrl: null, appAccountId: 'acct_app', appHomeActiveSessionCount: null,
        });
        expect(unseen.status === 'listed' && unseen.rows.every((row) => !('activeSessionCount' in row))).toBe(true);
    });
});
