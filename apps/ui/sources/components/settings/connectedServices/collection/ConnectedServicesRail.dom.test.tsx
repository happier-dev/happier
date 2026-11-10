// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { ConnectedServicesRailView, type ConnectedServicesRailViewProps } from './ConnectedServicesRail';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const rowSelector = '[data-testid^="connected-services-rail:account:"]';
// Physical browser geometry from the collection owner; no product row cap.
const dom = createWebListDomHarness({ rowSelector, rowHeight: HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight, width: 360, height: 400 });

it('muse.experience.pc12 mounts a viewport subset of 300 accounts and reaches the last account', async () => {
    const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    const accounts = Array.from({ length: 300 }, (_, index) => QualifiedConnectedAccountProfileV4Schema.parse({
        ref: { service, accountId: `account-${String(index).padStart(3, '0')}` }, status: 'connected',
        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true, configurationRevision: null, scopes: [], providerIdentity: { email: `person-${index}@example.com` },
    }));
    const model = buildConnectedServicesIndexModel({
        transport: 'advertised-v4', entries: [{ serviceId: service.localId, service, connectCommand: 'connect',
            supportsOauth: true, executable: true, projectedTitle: 'Claude' }],
        qualifiedAccounts: accounts, qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
        resolveLabel: () => 'Claude', resolveFallbackEntry: () => null,
        presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
    });
    const props: ConnectedServicesRailViewProps = {
        model, labelsByKey: {}, selection: { kind: 'index' }, identitiesHidden: false,
        present: input => presentConnectedAccountIdentity({ ...input, hidden: false, label: input.label ?? null,
            email: input.email ?? null, accountId: input.accountId ?? null }),
        onSetIdentitiesHidden: vi.fn(), onConnect: vi.fn(), onOpenIndex: vi.fn(), onOpenService: vi.fn(),
        onOpenAccount: vi.fn(), onOpenPool: vi.fn(), onOpenAgentSignIn: vi.fn(), renderAccountMeta: () => null,
    };
    const lastSheet = model.sheets.at(-1)!;
    const lastAccount = lastSheet.accounts.at(-1)!;
    const restoreAuth = installSignedOutAuthForTest();
    try {
        await act(async () => dom.root.render(<div id="virtualized-list-host" style={{ width: 360, height: 400, display: 'flex' }}>
            <ConnectedServicesRailView {...props} />
        </div>));
        await dom.flush();
        const mounted = dom.container.querySelectorAll(rowSelector).length;
        expect(model.sheets.flatMap(sheet => sheet.accounts)).toHaveLength(300);
        expect(mounted).toBeGreaterThan(0);
        expect(mounted).toBeLessThan(accounts.length);
        const scroller = [...dom.container.querySelectorAll<HTMLElement>('[style]')].find(element =>
            element.style.overflowY === 'auto' || element.style.overflow === 'auto');
        expect(scroller).toBeDefined();
        await act(async () => {
            scroller!.scrollTop = Math.max(0, scroller!.scrollHeight - scroller!.clientHeight);
            scroller!.dispatchEvent(new Event('scroll'));
        });
        await dom.flush();
        expect(dom.container.querySelector(`[data-testid="connected-services-rail:account:${lastSheet.serviceKey}:${lastAccount.accountId}"]`)).not.toBeNull();
        expect(dom.container.querySelectorAll(rowSelector).length).toBeLessThan(accounts.length);
    } finally { restoreAuth(); }
});
