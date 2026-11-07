import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { CollectionList, CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { t } from '@/text';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { ConnectedServicesRailView, RailAccountMeta, type ConnectedServicesRailViewProps } from './ConnectedServicesRail';

const CLAUDE = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
const KEYS = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
const GITHUB = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };

function entry(service: typeof CLAUDE, title: string): ConnectedServiceRegistryEntry {
    return { serviceId: service.localId, service, connectCommand: 'x', supportsOauth: true, executable: true, projectedTitle: title };
}

function account(service: typeof CLAUDE, accountId: string, email: string, status = 'connected'): QualifiedConnectedAccountProfileV4 {
    return {
        ref: { service, accountId }, status, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
        credentialRevision: 'r', configurationReady: true, configurationRevision: null, scopes: [], providerIdentity: { email },
    } as unknown as QualifiedConnectedAccountProfileV4;
}

const MODEL = buildConnectedServicesIndexModel({
    transport: 'advertised-v4',
    entries: [entry(CLAUDE, 'Claude'), entry(KEYS, 'Anthropic API key'), entry(GITHUB, 'GitHub')],
    qualifiedAccounts: [
        account(CLAUDE, 'work', 'leeroy@company.com'),
        account(CLAUDE, 'personal', 'leeroy.b@gmail.com', 'needs_reauth'),
        account(KEYS, 'build', 'build@company.com'),
        account(GITHUB, 'gh', 'dev@company.com'),
    ],
    qualifiedGroups: [{
        ref: { service: CLAUDE, groupId: 'work-pool' }, displayName: 'Work pool', activeConnectedAccountId: 'work',
        policy: { strategy: 'least_limited' }, members: [{ v: 1, connectedAccountId: 'work', priority: 0, enabled: true }],
    } as unknown as QualifiedConnectedAccountGroupV4],
    legacyServices: [],
    defaultAccountByServiceKey: {},
    resolveLabel: (candidate) => String(candidate?.projectedTitle ?? ''),
    resolveFallbackEntry: () => null,
    presentDiagnostics: () => ({ primary: null, supportDetails: null }),
    loadingLabel: 'Loading',
    agentUses: [{ agentId: 'claude', title: 'Claude Code', services: [CLAUDE, KEYS], defaults: [] }],
});

function render(overrides: Partial<ConnectedServicesRailViewProps> = {}, wrap: (view: React.ReactElement) => React.ReactElement = (view) => view) {
    const props: ConnectedServicesRailViewProps = {
        model: MODEL,
        labelsByKey: {},
        selection: { kind: 'index' },
        present: (input) => presentConnectedAccountIdentity({ ...input, hidden: false, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null }),
        identitiesHidden: false,
        onSetIdentitiesHidden: vi.fn(),
        onConnect: vi.fn(),
        onOpenIndex: vi.fn(),
        onOpenService: vi.fn(),
        onOpenAccount: vi.fn(),
        onOpenPool: vi.fn(),
        onOpenAgentSignIn: vi.fn(),
        renderAccountMeta: () => null,
        ...overrides,
    };
    return renderScreen(wrap(<ConnectedServicesRailView {...props} />));
}

const CLAUDE_KEY = 'happier.agent.claude/claude-subscription';

describe('ConnectedServicesRailView (lab csvc C1 rail)', () => {
    it('searches pools and derives group headings from matching rows, restoring them when cleared', async () => {
        const first = MODEL.sheets[0]!;
        const model = { ...MODEL, sheets: [{ ...first, accounts: [...first.accounts,
            ...Array.from({ length: 7 }, (_, index) => ({ ...first.accounts[0]!, accountId: `extra-${index}` })),
        ] }, ...MODEL.sheets.slice(1)] };
        const screen = await render({ model, secrets: { state: 'ready', onRetry: vi.fn(), entries: [SavedSecretCatalogEntryV1Schema.parse({
            ref: 'saved:deploy', source: 'personal', relationship: 'owner', name: 'QA_DEPLOY', kind: 'apiKey',
            revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        })] }, gateways: [{ connectionId: 'gateway', title: 'Team gateway', summary: 'Gateway',
            detailRoute: '/(app)/settings/providers/gateway', revision: 1, slotServices: [], agents: [] }],
            onAddGateway: vi.fn(), renderNewPool: () => null });
        const search = async (value: string) => act(async () => {
            screen.findAllByType(CollectionList)[0]!.props.search.onChangeText(value);
        });
        const groups = () => screen.findAllByType(CollectionListGroupLabel).map(node => node.props.title);
        await search('Work pool');
        expect(screen.findByTestId(`connected-services-rail:pool:${CLAUDE_KEY}:work-pool`)).not.toBeNull();
        expect(groups()).toEqual([t('connectedServicesCollection.poolsGroup')]);
        await search('nothing matches');
        expect(screen.findByTestId(`connected-services-rail:pool:${CLAUDE_KEY}:work-pool`)).toBeNull();
        expect(groups()).toEqual([]);
        await search('dev@company');
        expect(groups()).toEqual([t('connectedServicesSettings.codeAndToolsTitle')]);
        await search('QA_DEPLOY');
        expect(groups()).toEqual([t('connectedServicesCollection.secretsGroup')]);
        expect(screen.findByTestId('connected-services-rail:secret:saved:deploy')).not.toBeNull();
        await search('');
        expect(groups()).toContain(t('connectedServicesCollection.agentSignInGroup'));
        expect(groups()).toContain(t('settingsProvidersCollection.gateway.railGroup'));
    });

    it('counts matching accounts once in the filter footer and held status choices', async () => {
        // Popover placement reads the browser window, a platform boundary.
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
        try {
            const screen = await render();
            await screen.pressByTestIdAsync('connected-services-rail-filter-open');
            const editor = () => screen.findAll(node => node.props.testID === 'connected-services-rail-editor'
                && node.props.model !== undefined)[0]!;
            expect(editor().props.result.matchedCount).toBe(4);
            await act(async () => { editor().props.onChange({ type: 'add', condition: {
                fieldId: 'status', operator: 'is', values: ['needs_reauth'],
            } }); });
            expect(screen.findByTestId(`connected-services-rail:account:${CLAUDE_KEY}:personal`)).not.toBeNull();
            expect(screen.findByTestId(`connected-services-rail:account:${CLAUDE_KEY}:work`)).toBeNull();
            expect(editor().props.result.matchedCount).toBe(1);
            await screen.pressByTestIdAsync('collection-filter-condition:status:is:value');
            expect(editor().props.model.availableFields.find((field: { id: string }) => field.id === 'status').valueOptions)
                .toEqual(expect.arrayContaining([expect.objectContaining({ value: 'connected', count: 3 }),
                    expect.objectContaining({ value: 'needs_reauth', count: 1 })]));
        } finally { vi.unstubAllGlobals(); }
    });

    it.each(['future-peer-state', 'needs_reauth'] as const)('uses the held display status for a folded service: %s', async status => {
        const model = buildConnectedServicesIndexModel({
            transport: 'legacy',
            entries: [{ ...entry(KEYS, 'Anthropic API key'), serviceId: 'anthropic', legacyServiceId: 'anthropic' }],
            qualifiedAccounts: [], qualifiedGroups: [],
            legacyServices: [{ serviceId: 'anthropic', profiles: [{ profileId: 'held', status }] }],
            defaultAccountByServiceKey: {}, resolveLabel: () => 'Anthropic API key', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
        });
        const sheet = model.sheets[0]!;
        const screen = await render({ model });
        await screen.pressByTestIdAsync(`connected-services-rail:service:${sheet.serviceKey}`);
        const rollup = screen.findByTestId(`connected-services-rail:service-rollup:${sheet.serviceKey}`);
        if (status === 'needs_reauth') expect(rollup).not.toBeNull();
        else expect(rollup).toBeNull();
    });

    it('keeps an unclassified saved tool visible without presenting it as Agent sign-in', async () => {
        const model = { ...MODEL, sheets: MODEL.sheets.map(sheet => sheet.service.localId === GITHUB.localId
            ? { ...sheet, section: 'unknown' as const } : sheet) };
        const screen = await render({ model });
        // Each service row belongs to the group label drawn before it (open groups carry no count: owner 11-01).
        const drawn = JSON.stringify(screen.tree.toJSON());
        const at = (needle: string) => drawn.indexOf(needle);
        const servicesUnder = (title: string) => {
            const start = at(`"${title}"`);
            const next = [t('connectedServicesCollection.agentSignInGroup'), t('connectedServicesSettings.codeAndToolsTitle'), t('connectedServicesCollection.poolsGroup')]
                .map((other) => at(`"${other}"`)).filter((index) => index > start).sort((x, y) => x - y)[0] ?? drawn.length;
            return [CLAUDE_KEY, 'happier.agent.claude/anthropic', 'happier.scm.forge.github/github-account']
                .filter((key) => { const index = at(`"connected-services-rail:service:${key}"`); return index > start && index < next; });
        };
        expect(servicesUnder(t('connectedServicesCollection.agentSignInGroup'))).toEqual([CLAUDE_KEY, 'happier.agent.claude/anthropic']);
        expect(servicesUnder(t('connectedServicesSettings.codeAndToolsTitle'))).toEqual(['happier.scm.forge.github/github-account']);
        expect(screen.findByTestId('connected-services-rail:account:happier.scm.forge.github/github-account:gh')).not.toBeNull();
    });

    it('counts a service only while it is folded; its "+" keeps the end column either way (owner 11-01)', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await render({ onAddAccount: vi.fn() });
        const endOf = () => screen.findAllByType(Item).find((node) => node.props.testID === `connected-services-rail:service:${CLAUDE_KEY}`)!;
        const countIn = (node: ReturnType<typeof endOf>) => node.findAll((child) => typeof child.props.children === 'string' && child.props.children === '2').length > 0;
        // Open: its two accounts are listed under it, so the row adds no "2".
        expect(countIn(endOf())).toBe(false);
        expect(screen.findByTestId(`connected-services-rail:service:${CLAUDE_KEY}:add`)).not.toBeNull();
        await screen.pressByTestIdAsync(`connected-services-rail:service:${CLAUDE_KEY}`);
        // Folded: the count stands for the hidden accounts, beside the same "+".
        expect(countIn(endOf())).toBe(true);
        expect(screen.findByTestId(`connected-services-rail:service:${CLAUDE_KEY}:add`)).not.toBeNull();
    });

    it('expands every service by default, folds one in place, and opens the pressed account', async () => {
        const onOpenAccount = vi.fn();
        const onOpenService = vi.fn();
        const screen = await render({ onOpenAccount, onOpenService });

        // Owner 10-31: groups open by default, single-account services too.
        expect(screen.findByTestId(`connected-services-rail:account:${CLAUDE_KEY}:work`)).toBeTruthy();
        expect(screen.findByTestId('connected-services-rail:account:happier.agent.claude/anthropic:build')).toBeTruthy();
        const { Item } = await import('@/components/ui/lists/Item');
        const navigation = screen.findAllByType(Item).filter(node => /^connected-services-rail:(service|account|pool|gateway):/.test(node.props.testID ?? ''));
        expect(navigation.length).toBeGreaterThan(0);
        expect(navigation.every(node => node.props.rowRole === 'item' && node.props.titleLines === 1)).toBe(true);

        await screen.pressByTestIdAsync('connected-services-rail:service:happier.scm.forge.github/github-account');
        expect(onOpenService).not.toHaveBeenCalled();
        expect(screen.findByTestId('connected-services-rail:account:happier.scm.forge.github/github-account:gh')).toBeNull();
        await screen.pressByTestIdAsync('connected-services-rail:service:happier.scm.forge.github/github-account');
        expect(screen.findByTestId('connected-services-rail:account:happier.scm.forge.github/github-account:gh')).toBeTruthy();

        screen.pressByTestId(`connected-services-rail:account:${CLAUDE_KEY}:personal`);
        expect(onOpenAccount).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: CLAUDE_KEY }), 'personal');
    });

    it('keeps the service mark at rest and swaps it for the disclosure on hover; accounts carry the mark one step in', async () => {
        const screen = await render();
        const { Item } = await import('@/components/ui/lists/Item');
        const { HAPPIER_COLLECTION_LIST_METRICS, resolveHappierCollectionListRowPadding } = await import('@happier-dev/plugin-ui/presentation');
        const items = screen.findAllByType(Item);
        const service = items.find(node => node.props.testID === `connected-services-rail:service:${CLAUDE_KEY}`)!;
        // No persistent caret: the mark leads; hover (and keyboard focus) shows the disclosure in its place.
        expect(service.props.accessibilityExpanded).toBe(true);
        expect(service.props.leftElement).toBeTruthy();
        expect(service.props.leftElementWhenHovered).toBeTruthy();
        expect(service.props.leftElement).not.toBe(service.props.leftElementWhenHovered);
        // An account starts where its service's mark ends: the mark's box and gap, and draws the mark itself.
        const accountRow = items.find(node => node.props.testID === `connected-services-rail:account:${CLAUDE_KEY}:work`)!;
        const nested = resolveHappierCollectionListRowPadding(HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox + HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap);
        expect(accountRow.props.style).toMatchObject({ paddingLeft: nested.paddingLeft });
        expect(accountRow.props.icon).toBeTruthy();
    });

    it.each(['accountDraft', 'poolDraft'] as const)('keeps the selected %s service expanded even after a collapse request', async kind => {
        const serviceKey = 'happier.agent.claude/anthropic';
        const screen = await render({ selection: { kind, serviceKey } });

        expect(screen.findByTestId(`connected-services-rail:account:${serviceKey}:build`)).not.toBeNull();
        await screen.pressByTestIdAsync(`connected-services-rail:service:${serviceKey}`);
        expect(screen.findByTestId(`connected-services-rail:account:${serviceKey}:build`)).not.toBeNull();
    });

    it('draws the account being added as a draft row inside its own service group, the group held open', async () => {
        const serviceKey = 'happier.agent.claude/anthropic';
        const screen = await render({ selection: { kind: 'accountDraft', serviceKey } });

        const draft = screen.findByTestId(`connected-services-rail:account-draft:${serviceKey}`);
        expect(draft).not.toBeNull();
        // Inside its group: after its service row, before that service's own accounts.
        const order = screen.tree.root.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('connected-services-rail:'))
            .map((node) => node.props.testID as string)
            .filter((id, index, all) => all.indexOf(id) === index);
        const draftAt = order.indexOf(`connected-services-rail:account-draft:${serviceKey}`);
        expect(order.indexOf(`connected-services-rail:service:${serviceKey}`)).toBe(draftAt - 1);
        expect(order.indexOf(`connected-services-rail:account:${serviceKey}:build`)).toBeGreaterThan(draftAt);
        expect(screen.findByTestId('connected-services-rail:account-draft:happier.agent.claude/claude-subscription')).toBeNull();
    });

    it('keeps the draft row of a first account while the agents that use its service are still unknown', async () => {
        // Agent uses resolve after the accounts: the rail lists an unclassified service with Code and tools, and a
        // draft for a service with nothing added yet must stay where its group is drawn, not vanish until they load.
        const service = { pluginId: 'happier.scm.forge.linear', localId: 'linear-account' };
        const serviceKey = 'happier.scm.forge.linear/linear-account';
        const model = { ...MODEL, connectable: [...MODEL.connectable, {
            serviceKey, service, entry: MODEL.sheets[0]!.entry!, label: 'Linear', usedBy: [], usedByAgentIds: [], section: 'unknown' as const,
        }] };
        const screen = await render({ model, selection: { kind: 'accountDraft', serviceKey } });
        expect(screen.findByTestId(`connected-services-rail:account-draft:${serviceKey}`)).not.toBeNull();
    });

    it('lists the pools with the member each uses now, and opens the pressed pool', async () => {
        const onOpenPool = vi.fn();
        const screen = await render({ onOpenPool });

        screen.pressByTestId(`connected-services-rail:pool:${CLAUDE_KEY}:work-pool`);
        expect(onOpenPool).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: CLAUDE_KEY }), 'work-pool');
    });

    it('lists gateways after the pools they compose and opens the pressed one; without any the group is absent', async () => {
        const onOpenGateway = vi.fn();
        const gateway = { connectionId: 'pc_gateway', title: 'Main gateway', detailRoute: '/(app)/settings/providers/pc_gateway', revision: 3, slotServices: [], summary: 'Not set', agents: [] };
        const screen = await render({ gateways: [gateway], onOpenGateway });

        screen.pressByTestId('connected-services-rail:gateway:pc_gateway');
        expect(onOpenGateway).toHaveBeenCalledWith(gateway);

        const none = await render({ gateways: [] });
        expect(none.findByTestId('connected-services-rail:gateway:pc_gateway')).toBeNull();
    });

    it('says under each gateway what it draws on, and keeps the group in place while its catalog loads', async () => {
        const gateway = { connectionId: 'pc_gateway', title: 'Main gateway', detailRoute: '/(app)/settings/providers/pc_gateway', revision: 3, slotServices: [CLAUDE], summary: 'Claude · ChatGPT', agents: [] };
        const listed = await render({ gateways: [gateway] });
        expect(listed.getTextContent()).toContain('Claude · ChatGPT');

        const loading = await render({ gateways: undefined, gatewaysLoading: true });
        expect(loading.findByTestId('connected-services-rail:gateways-loading')).toBeTruthy();
        expect(loading.findByTestId('connected-services-rail:add-gateway')).toBeNull();
    });

    it('keeps the Gateways place when its catalog cannot be read, and retries from it', async () => {
        const retry = vi.fn();
        const screen = await render({ gateways: undefined, gatewaysUnavailable: { diagnosticCode: 'encryption-material-unavailable', onRetry: retry } });
        expect(screen.findByTestId('connected-services-rail:gateways-unavailable')).toBeTruthy();
        await screen.pressByTestIdAsync('connected-services-rail:gateways-unavailable.retry');
        expect(retry).toHaveBeenCalledOnce();
        expect(screen.findByTestId('connected-services-rail:add-gateway')).toBeNull();
    });

    it('on the phone page hands "+" and the privacy eye to the navigation bar, leaving the list without a head row', async () => {
        const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');
        const phone = await render({ variant: 'page' }, (view) => <NavigationTitleChromeProvider showsTitle>{view}</NavigationTitleChromeProvider>);
        // The navigation bar publisher (its props: no primary, the folded actions, the trailing trigger).
        const bar = phone.root.findAll((node) => node.props.primary === null && node.props.trailing !== undefined)[0];
        expect(bar).toBeDefined();
        const trailing = await renderScreen(bar!.props.trailing as React.ReactElement);
        expect(trailing.findByTestId('connected-services-rail:connect')).not.toBeNull();
        // The eye becomes a checked row of the bar's menu (a folded toolbar operation).
        expect(bar!.props.actions.props).toMatchObject({ testID: 'connected-services-rail:privacy', active: false });
        // The list itself draws neither control a second time.
        expect(phone.findByTestId('connected-services-rail:connect')).toBeNull();
        expect(phone.findByTestId('connected-services-rail:privacy')).toBeNull();
        // Beside a detail (no navigation title), the list's head keeps both.
        const wide = await render();
        expect(wide.findByTestId('connected-services-rail:connect')).not.toBeNull();
        expect(wide.findByTestId('connected-services-rail:privacy')).not.toBeNull();
    });

    it('names accounts through the privacy presenter: an address used as a name is masked when identities are hidden', async () => {
        const screen = await render({
            present: (input) => presentConnectedAccountIdentity({ ...input, hidden: true, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null }),
        });

        const text = screen.getTextContent();
        expect(text).not.toContain('leeroy@company.com');
        expect(text).toContain('le•••@c•••.com');
    });

    it('says what an account needs at its end: its tightest limit, a stale read, or that it is signed out', async () => {
        const usage = await renderScreen(<RailAccountMeta meta={{ kind: 'usage', tightestPct: 6.4, stale: false }} />);
        expect(usage.getTextContent()).toContain('6%');

        const signedOut = await renderScreen(<RailAccountMeta meta={{ kind: 'signedOut' }} />);
        expect(signedOut.getTextContent()).not.toContain('%');
    });
});
