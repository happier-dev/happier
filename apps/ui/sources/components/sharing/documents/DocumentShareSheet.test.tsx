import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS } from '@/components/ui/selectionList/_constants';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { DocumentShareSheet } from './DocumentShareSheet';
import { useDocumentShareController } from './useDocumentShareController';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The virtualized list is a third-party rendering boundary; the testkit owns it.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true, renderItemLimit: 40 }).module.LegendList };
});
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: vi.fn(async () => true) } }).module;
});

/**
 * HTTP is the sheet's boundary: the real Action front door, its policy, the Artifact grant Actions,
 * the document-kind adapters and the Home's account context all run. The fake Home keeps one stored
 * document and its grant list and answers the routes the way the server does.
 */
const host = vi.hoisted(() => ({
    serverId: '',
    /** Grant requests the Home received: `GET`, or the mutation with its body. */
    requests: [] as Array<Readonly<{ method: string; body?: Record<string, unknown> }>>,
    access: 'owner' as import('@happier-dev/protocol').ArtifactCallerAccessV1 | null,
    ownerAccountId: 'owner',
    revokeOnRemove: false,
    grants: [] as any[],
    grantStatus: 200,
    document: { header: {} as Record<string, unknown>, body: '' },
    publicShare: null as import('@happier-dev/protocol').StoredContentPublicShareV1 | null,
    publicRequests: [] as Array<Readonly<{ method: string; body?: unknown }>>,
}));

const WORKFLOW_DOCUMENT = {
    header: { kind: 'workflow-definition.v1', definitionId: 'wf-1', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Workflow' } },
    body: 'definition',
};
const PROFILE_DOCUMENT = {
    header: { kind: 'launch-profile.v1', profileId: 'deploy', name: 'Deploy' },
    body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: 'deploy', name: 'Deploy', createdAt: 1, updatedAt: 1 }, secretBindings: {} }),
};

let disposeHome: (() => void) | null = null;
async function serveHome(): Promise<void> {
    const served = await serveActionHomes({
        homes: [
            { key: 'home', serverUrl: 'https://document-share-sheet.test', accountId: 'owner' },
            { key: 'focused', serverUrl: 'https://document-share-focused.test', accountId: 'another-owner' },
        ],
        route: (request) => {
            // The sheet targets its captured profile scope, not the focused Home's transport.
            if (request.home !== 'home') return undefined;
            if (request.path.startsWith('/v1/public-shares')) {
                host.publicRequests.push({ method: request.method, ...(request.body ? { body: request.body } : {}) });
                if (request.path.endsWith('/access-log')) return Response.json({ accessLog: [{ id: 'visit-1',
                    accessedAt: 1780000000000, ipAddress: '192.0.2.1', userAgent: 'Browser' }] });
                if (request.method === 'POST') {
                    const input = request.body as import('@happier-dev/protocol').StoredContentPublicShareCreateRequestV1;
                    host.publicShare = { id: 'share-1', subject: input.subject, expiresAt: input.expiresAt ?? null,
                        maxUses: input.maxUses ?? null, useCount: 0, isConsentRequired: input.isConsentRequired ?? false,
                        createdAt: 1, updatedAt: 1, keyDerivation: input.keyDerivation };
                    return Response.json({ publicShare: host.publicShare, isolatedOrigin: 'https://isolated.test' });
                }
                if (request.method === 'DELETE') { host.publicShare = null; return Response.json({ success: true }); }
                return Response.json({ publicShares: host.publicShare ? [host.publicShare] : [] });
            }
            const route = /^\/v1\/artifacts\/([^/]+)(\/access\/grants)?$/.exec(request.path);
            if (!route) return undefined;
            const artifactId = decodeURIComponent(route[1]!);
            if (!route[2]) {
                if (host.access === null) return Response.json({ error: 'not_found' }, { status: 404 });
                return Response.json({ id: artifactId, header: encodePlainArtifactStoredContent(host.document.header),
                    body: encodePlainArtifactStoredContent({ body: host.document.body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: host.ownerAccountId, access: host.access, encryptionMode: 'plain' });
            }
            const input = request.body as any;
            host.requests.push({ method: request.method, ...(input ? { body: input } : {}) });
            if (host.grantStatus !== 200) return Response.json({ error: 'not_found' }, { status: host.grantStatus });
            if (host.access === null) return Response.json({ error: 'not_found' }, { status: 404 });
            const same = (row: any) => JSON.stringify(row.principal) === JSON.stringify(input.principal);
            if (request.method === 'PUT') {
                const display = host.grants.find(same)?.display ?? (input.principal.kind === 'team' ? { name: 'Payments squad' } : { name: 'Someone' });
                host.grants = [...host.grants.filter((row) => !same(row)),
                    { principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'owner', createdAt: 1, display }];
            }
            if (request.method === 'DELETE') host.grants = host.grants.filter((row) => !same(row));
            if (request.method === 'DELETE' && host.revokeOnRemove) host.access = null;
            return Response.json({ artifactId, ownerAccountId: host.ownerAccountId, access: host.access, grants: host.access === null ? [] : host.grants,
                ...(request.method === 'GET' ? {} : { changed: true }) });
        },
    });
    host.serverId = served.homes.home!.id;
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sharing.public', true)) throw new Error('Unable to enable public sharing');
    primeServerFeaturesSnapshot({ serverId: host.serverId, snapshot: { status: 'ready', features } });
    const sheetScope = { serverId: host.serverId, accountId: 'owner' };
    getStorage().setState({ profileScope: sheetScope, settingsScope: sheetScope });
    disposeHome = served.dispose;
}

// Team and Account directories are Home reads, a network boundary below the existing principal search.
vi.mock('@/sync/ops/teams/teamActionClient', () => ({
    runTeamAction: vi.fn(async () => ({ kind: 'succeeded', value: { items: [{
        id: 'payments', name: 'Payments squad', policy: { sessionCreationPolicy: 'personal_allowed', externalSharingPolicy: 'allowed' },
    }], nextCursor: null } })),
}));
vi.mock('@/sync/ops/teams/teamGroupOperations', () => ({
    listTeamGroups: vi.fn(async () => ({ kind: 'succeeded', value: { items: [], nextCursor: null } })),
}));
vi.mock('@/sync/api/session/sessionAccessApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/session/sessionAccessApi')>(),
    searchSessionAccessAccountPage: vi.fn(async () => ({ rows: [], nextCursor: null })),
}));

const ana = { principal: { kind: 'account', accountId: 'ana' }, accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1,
    display: { name: 'Ana Silva', username: 'ana' } };
const studio = { principal: { kind: 'team', teamId: 'studio' }, accessLevel: 'view', createdByAccountId: 'owner', createdAt: 2,
    display: { name: 'Studio' } };

function renderedTestIds(screen: Awaited<ReturnType<typeof renderScreen>>, prefix: string): string[] {
    // A pressable renders more than one host node carrying its testID; keep each id once, in render order.
    return [...new Set(screen.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith(prefix)
        && typeof node.type === 'string').map((node) => node.props.testID as string))];
}

async function settle() {
    await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });
    await flushHookEffects();
}

describe('DocumentShareSheet', () => {
    beforeEach(async () => {
        host.requests = [];
        host.access = 'owner';
        host.ownerAccountId = 'owner';
        host.revokeOnRemove = false;
        host.grants = [ana, studio];
        host.grantStatus = 200;
        host.document = WORKFLOW_DOCUMENT;
        host.publicShare = null;
        host.publicRequests = [];
        await serveHome();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        disposeHome?.();
        disposeHome = null;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
    });

    it('keeps people sharing available for a widget layout without offering or loading public links', async () => {
        host.document = { header: { kind: 'widget-area-layout.v1' }, body: '{}' };
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="widget-area-layout.v1" />);
        await settle();
        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
        expect(renderedTestIds(screen, 'document-share-public-link')).toEqual([]);
        expect(host.publicRequests).toEqual([]);
    });

    it.each(['work-board.v1', 'prompt_doc.v2'])('refuses malformed opened %s content through the Action owner', async kind => {
        host.document = { header: { v: 1, kind, title: 'Unreadable document' }, body: '{' };
        const hook = await renderHook(() => useDocumentShareController({ artifactId: 'invalid-document',
            scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        // Retained grants remain inspectable/revocable; only new sharing requires content admission.
        expect(hook.getCurrent().grants).toHaveLength(2);
        await React.act(async () => { hook.getCurrent().actions.setAccessLevel({ kind: 'account', accountId: 'ana' }, 'view'); });
        await settle();
        const anaRow = hook.getCurrent().model.grants.find(row => row.principal.ref.kind === 'account'
            && row.principal.ref.accountId === 'ana');
        expect(anaRow?.operation).toMatchObject({ kind: 'error' });
        expect(anaRow?.level).toMatchObject({ value: 'edit' });
        expect(host.requests).toEqual([{ method: 'GET' }]);
        await hook.unmount();
    });

    it('lists a workflow\'s grants with the document labels and the Team-run rule', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(host.requests[0]).toEqual({ method: 'GET' });
        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
        expect(screen.findByTestId('document-share-grant-team:studio')).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('Can edit');
        expect(text).toContain('Can use');
        expect(text).not.toContain('Can steer');
        expect(text).toContain('The team sees every run');
    });

    it('changes, adds and removes access only through the Artifact grant Actions', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        await screen.pressByTestIdAsync('document-share-level:account:ana');
        // Levels keep one order whatever the adapter or the grant says.
        expect(renderedTestIds(screen, 'document-share-level:account:ana:')).toEqual([
            'document-share-level:account:ana:view', 'document-share-level:account:ana:edit', 'document-share-level:account:ana:admin',
        ]);
        await screen.pressByTestIdAsync('document-share-level:account:ana:admin');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'PUT',
            body: { artifactId: 'wf-1', principal: { kind: 'account', accountId: 'ana' }, accessLevel: 'admin' } });

        await screen.pressByTestIdAsync('document-share-candidate-team:payments');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'PUT',
            body: { artifactId: 'wf-1', principal: { kind: 'team', teamId: 'payments' }, accessLevel: 'view' } });
        expect(screen.findByTestId('document-share-grant-team:payments')).not.toBeNull();

        await screen.pressByTestIdAsync('document-share-grant-team:studio');
        await screen.pressByTestIdAsync('document-share-remove:team:studio');
        expect(host.requests.at(-1)?.method).not.toBe('DELETE');
        await screen.pressByTestIdAsync('document-share-remove-confirm:team:studio');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'DELETE',
            body: { artifactId: 'wf-1', principal: { kind: 'team', teamId: 'studio' } } });
        expect(screen.findByTestId('document-share-grant-team:studio')).toBeNull();
    });

    it('lets an administrator edit, add and remove grants without assigning admin', async () => {
        host.access = 'admin';
        host.ownerAccountId = 'document-owner';
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(screen.findByTestId('document-share-candidate-team:payments')).not.toBeNull();
        expect(screen.findByTestId('document-share-public-link')).toBeNull();
        expect(host.publicRequests).toEqual([]);
        await screen.pressByTestIdAsync('document-share-level:account:ana');
        expect(renderedTestIds(screen, 'document-share-level:account:ana:')).toEqual([
            'document-share-level:account:ana:view', 'document-share-level:account:ana:edit',
        ]);
        await screen.pressByTestIdAsync('document-share-level:account:ana:view');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'PUT',
            body: { artifactId: 'wf-1', principal: { kind: 'account', accountId: 'ana' }, accessLevel: 'view' } });

        await screen.pressByTestIdAsync('document-share-candidate-team:payments');
        await settle();
        expect(screen.findByTestId('document-share-grant-team:payments')).not.toBeNull();
        await screen.pressByTestIdAsync('document-share-grant-team:studio');
        await screen.pressByTestIdAsync('document-share-remove:team:studio');
        await screen.pressByTestIdAsync('document-share-remove-confirm:team:studio');
        await settle();
        expect(screen.findByTestId('document-share-grant-team:studio')).toBeNull();
        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
    });

    it('clears the controller roster after acknowledged self-revocation', async () => {
        host.access = 'admin';
        host.ownerAccountId = 'document-owner';
        host.revokeOnRemove = true;
        const self = { kind: 'account' as const, accountId: 'owner' };
        host.grants = [{ ...ana, principal: self, accessLevel: 'admin' }, studio];
        const hook = await renderHook(() => useDocumentShareController({ artifactId: 'wf-1',
            scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        expect(hook.getCurrent().grants).toHaveLength(2);

        hook.getCurrent().actions.confirmRemove(self);
        await settle();
        expect(host.access).toBeNull();
        expect(hook.getCurrent().grants).toEqual([]);
        expect(hook.getCurrent().model).toMatchObject({ editable: false, stale: false, owner: null, grants: [], directory: { sections: [] } });
        expect(hook.getCurrent().issue).toMatchObject({ code: 'artifact_access_revoked', retryable: false });
        expect(hook.getCurrent().loading).toBe(false);
    });

    it('replaces the sheet controls with an access-lost state after self-revocation', async () => {
        host.access = 'admin';
        host.ownerAccountId = 'document-owner';
        host.revokeOnRemove = true;
        host.grants = [{ ...ana, principal: { kind: 'account', accountId: 'owner' }, accessLevel: 'admin' }, studio];
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-grant-account:owner');
        await screen.pressByTestIdAsync('document-share-remove:account:owner');
        await screen.pressByTestIdAsync('document-share-remove-confirm:account:owner');
        await settle();

        expect(renderedTestIds(screen, 'document-share-grant-')).toEqual([]);
        expect(renderedTestIds(screen, 'document-share-candidate-')).toEqual([]);
        expect(screen.findByTestId('document-share-public-link')).toBeNull();
        expect(screen.findByTestId('document-share-editor:list:document-share:option:issue')).not.toBeNull();
        expect(screen.findByTestId('document-share-editor:list:document-share:option:read-only')).toBeNull();
    });

    it('shows a recipient the roster without any way to change it', async () => {
        host.access = 'edit';
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
        expect(screen.findByTestId('document-share-candidate-team:payments')).toBeNull();
        await screen.pressByTestIdAsync('document-share-grant-account:ana');
        expect(screen.findByTestId('document-share-remove:account:ana')).toBeNull();
        expect(screen.findByTestId('document-share-level:account:ana:admin')).toBeNull();
        expect(screen.findByTestId('document-share-public-link')).toBeNull();
        expect(host.publicRequests).toEqual([]);
    });

    it('offers the owner a public-link row inside the existing share sheet', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(host.publicRequests).toEqual([{ method: 'GET' }]);
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        expect(screen.findByTestId('document-share-public-link-controls')).not.toBeNull();
    });

    it('shows an existing public link as on before the owner opens its controls', async () => {
        host.publicShare = { id: 'existing-share', subject: { kind: 'artifact', id: 'wf-1' },
            expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
            createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('On');
        expect(screen.findByTestId('document-share-public-link-controls')).toBeNull();
    });

    it('creates a local fragment link, reads the owner audit and revokes through the canonical Actions', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        await screen.pressByTestIdAsync('session-public-link-create');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();

        const issuedUrl = screen.findByTestId('session-public-link-url')?.props.children as string;
        const url = new URL(issuedUrl);
        expect(url.origin).toBe('https://isolated.test');
        expect(url.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]+$/);
        expect(url.hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);
        const created = host.publicRequests.find((request) => request.method === 'POST')!;
        expect(created.body).toMatchObject({ subject: { kind: 'artifact', id: 'wf-1' }, keyDerivation: 'fragment_v1' });
        expect(JSON.stringify(host.publicRequests)).not.toContain(url.hash.slice(3));
        expect(created.body).not.toHaveProperty('encryptedDataKey');
        await screen.pressByTestIdAsync('document-share-grant-account:ana');
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        expect(screen.findByTestId('session-public-link-url')?.props.children).toBe(issuedUrl);
        await screen.pressByTestIdAsync('document-share-public-link-audit');
        await settle();
        expect(screen.findByTestId('document-share-public-link-visit:visit-1')).not.toBeNull();

        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await settle();
        expect(host.publicShare).toBeNull();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(screen.findByTestId('session-public-link-url')).toBeNull();
        expect(host.publicRequests.some(request => request.method === 'DELETE')).toBe(true);
    });

    it('tells a profile owner that secret values never travel', async () => {
        host.grants = [];
        host.document = PROFILE_DOCUMENT;
        const screen = await renderScreen(<DocumentShareSheet artifactId="profile-1" kind="launch-profile.v1" />);
        await settle();

        expect(host.requests[0]).toEqual({ method: 'GET' });
        expect(screen.getTextContent()).toContain('Secret values never travel');
    });

    it('keeps the sheet explaining itself when this device cannot reach document sharing', async () => {
        // An older Home without the grant routes.
        host.grantStatus = 404;
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(screen.findByTestId('document-share-grant-account:ana')).toBeNull();
        expect(screen.findByTestId('document-share-candidate-team:payments')).toBeNull();
        expect(screen.findByTestId('document-share-editor:list:document-share:option:issue')).not.toBeNull();
    });
});
