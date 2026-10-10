import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
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

function render(overrides: Partial<ConnectedServicesRailViewProps> = {}) {
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
    return renderScreen(<ConnectedServicesRailView {...props} />);
}

const CLAUDE_KEY = 'happier.agent.claude/claude-subscription';

describe('ConnectedServicesRailView (lab csvc C1 rail)', () => {
    it('opens a service with several accounts, keeps a single-account service closed, and opens the pressed account', async () => {
        const onOpenAccount = vi.fn();
        const screen = await render({ onOpenAccount });

        expect(screen.findByTestId(`connected-services-rail:account:${CLAUDE_KEY}:work`)).toBeTruthy();
        expect(screen.findByTestId('connected-services-rail:account:happier.agent.claude/anthropic:build')).toBeNull();

        screen.pressByTestId(`connected-services-rail:account:${CLAUDE_KEY}:personal`);
        expect(onOpenAccount).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: CLAUDE_KEY }), 'personal');
    });

    it('discloses a closed service in place, code hosts included, instead of navigating away', async () => {
        const onOpenService = vi.fn();
        const screen = await render({ onOpenService });

        await screen.pressByTestIdAsync('connected-services-rail:service:happier.scm.forge.github/github-account');
        expect(onOpenService).not.toHaveBeenCalled();
        expect(screen.findByTestId('connected-services-rail:account:happier.scm.forge.github/github-account:gh')).toBeTruthy();
    });

    it('lists the pools with the member each uses now, and opens the pressed pool', async () => {
        const onOpenPool = vi.fn();
        const screen = await render({ onOpenPool });

        screen.pressByTestId(`connected-services-rail:pool:${CLAUDE_KEY}:work-pool`);
        expect(onOpenPool).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: CLAUDE_KEY }), 'work-pool');
    });

    it('lists gateways after the pools they compose and opens the pressed one; without any the group is absent', async () => {
        const onOpenGateway = vi.fn();
        const gateway = { connectionId: 'pc_gateway', title: 'Main gateway', detailRoute: '/(app)/settings/providers/pc_gateway', revision: 3 };
        const screen = await render({ gateways: [gateway], onOpenGateway });

        screen.pressByTestId('connected-services-rail:gateway:pc_gateway');
        expect(onOpenGateway).toHaveBeenCalledWith(gateway);

        const none = await render({ gateways: [] });
        expect(none.findByTestId('connected-services-rail:gateway:pc_gateway')).toBeNull();
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
