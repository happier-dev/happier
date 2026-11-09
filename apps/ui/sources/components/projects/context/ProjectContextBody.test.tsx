import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { installPromptStacksCommonModuleMocks } from '@/components/settings/prompts/stacks/promptStacksScreenTestHelpers';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ArtifactAccessGrantsListResponseV1Schema, type ArtifactAccessGrantRowV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Storage, the Project rows domain and the Context model stay real; only platform boundaries are mocked.
installPromptStacksCommonModuleMocks({ storage: importOriginal => importOriginal() });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
afterEach(async () => { standardCleanup(); await homes.reset(); });

vi.mock('@/components/ui/popover', async importOriginal => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));
vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
}));

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { ProjectContextBody } = await import('./ProjectContextBody');
const { ProjectMemoryBody } = await import('../memory/ProjectMemoryBody');
const { PromptStackDocumentMenu } = await import('@/components/settings/prompts/stacks/PromptStackDocumentMenu');
const baseline = storage.getState();
let caseSignal: AbortSignal;

async function settled(check: () => void) {
    const signal = caseSignal;
    await waitForHomeGovernance(async () => {
        signal.throwIfAborted();
        await flushHookEffects();
        signal.throwIfAborted();
        check();
    });
}

const scope = { serverId: 'project-context-home', accountId: 'project-context-account' };
const workspaceRef = { id: 'wr_1', serverId: scope.serverId, machineId: 'm1', rootPath: '/repo/happier', projectKey: 'happier', createdAtMs: 1 };
const entry = (id: string, artifactId: string) => ({ id, ref: { kind: 'doc' as const, artifactId }, enabled: true, placement: 'system_append' as const });
const artifact = (id: string, kind: string, title: string) => ({ id, title, headerVersion: 1, bodyVersion: 1, ownerAccountId: scope.accountId,
    access: 'owner' as const, header: { kind, title }, body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true as const });

describe('ProjectContextBody', () => {
    beforeEach(({ signal }) => {
        caseSignal = signal;
        installHomeGovernanceBoundaries(homes);
        storage.setState(baseline, true);
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope, profileScope: scope, isDataReady: true });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://project-context.invalid', generation: 1 });
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete', workspaceRefs: [workspaceRef], relationships: [],
            organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'happier' }, revision: 3,
                value: { promptStack: [entry('memory-entry', 'memory-1'), entry('guide-entry', 'guide-1'), entry('gone-entry', 'gone-1')] } }],
            revisionsByPhysicalKey: {} });
        storage.getState().applyArtifacts([artifact('memory-1', 'memory_doc.v1', 'Project memory'), artifact('guide-1', 'prompt_doc.v2', 'API style guide')]);
    });

    it('offers remember before the Project has a memory document', async () => {
        storage.getState().applyArtifacts([artifact('guide-1', 'prompt_doc.v2', 'API style guide')]);
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete', workspaceRefs: [workspaceRef], relationships: [],
            organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'happier' }, revision: 4,
                value: { promptStack: [entry('guide-entry', 'guide-1')] } }], revisionsByPhysicalKey: {} });
        const screen = await renderScreen(<ProjectContextBody workspaceRef={workspaceRef} />);
        expect(screen.findByTestId('project-context.memory.remember')).toBeTruthy();
        await screen.pressByTestIdAsync('project-context.memory.remember');
        expect(screen.findByTestId('project-context.memory.draft')).toBeTruthy();
    });

    it('keeps the Memory page search field in place while its memory is first read, so it does not appear when the document resolves', async () => {
        storage.getState().clearProjectAccountRowsScope();
        storage.getState().activateProjectAccountRowsScope(scope);
        const screen = await renderScreen(<ProjectMemoryBody workspaceRef={workspaceRef} />);
        expect(screen.findByTestId('project-memory.memory.loading')).toBeTruthy();
        expect(screen.findByTestId('project-memory.memory.searchPanel.input')).toBeTruthy();
        // The Context page is one section among others: its search stays the section's own icon.
        const context = await renderScreen(<ProjectContextBody workspaceRef={workspaceRef} />);
        expect(context.findByTestId('project-context.memory.searchPanel.input')).toBeNull();
    });

    describe.each([
        ['Context', ProjectContextBody, 'project-context.memory', ['none', 'remember']],
        // The Memory page is a page of its own memory: confirmed absence is its one empty state, with the first save as its action.
        ['Memory', ProjectMemoryBody, 'project-memory.memory', ['firstUse', 'firstUse-action']],
    ] as const)('%s Project read status', (_name, Body, memoryTestID, [absent, firstSave]) => {
        it('does not turn an unresolved attached document kind into confirmed empty memory', async () => {
            storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
                workspaceRefs: [workspaceRef], relationships: [], organizations: [{ key: {
                    kind: 'project-organization', serverId: scope.serverId, projectKey: 'happier',
                }, revision: 4, value: { promptStack: [entry('unknown-kind', 'not-opened')] } }], revisionsByPhysicalKey: {} });
            const screen = await renderScreen(<Body workspaceRef={workspaceRef} />);
            expect(Boolean(screen.findByTestId(`${memoryTestID}.none`))).toBe(false);
            expect(Boolean(screen.findByTestId(`${memoryTestID}.remember`))).toBe(false);
            expect(screen.findByTestId(`${memoryTestID}.loading`)).toBeTruthy();
            expect(screen.findByTestId(`${memoryTestID}.unavailable`)).toBeNull();
        });

        it('keeps unknown memory loading until a complete Project read establishes absence', async () => {
            storage.getState().clearProjectAccountRowsScope();
            storage.getState().activateProjectAccountRowsScope(scope);
            const screen = await renderScreen(<Body workspaceRef={workspaceRef} />);
            expect(screen.findByTestId(`${memoryTestID}.none`)).toBeNull();
            expect(screen.findByTestId(`${memoryTestID}.remember`)).toBeNull();
            expect(screen.findByTestId(`${memoryTestID}.loading`)).toBeTruthy();

            await act(async () => {
                storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'partial',
                    workspaceRefs: [workspaceRef], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
            });
            expect(screen.findByTestId(`${memoryTestID}.none`)).toBeNull();
            expect(screen.findByTestId(`${memoryTestID}.loading`)).toBeTruthy();

            await act(async () => {
                storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
                    workspaceRefs: [workspaceRef], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
            });
            expect(screen.findByTestId(`${memoryTestID}.loading`)).toBeNull();
            expect(screen.findByTestId(`${memoryTestID}.${absent}`)).toBeTruthy();
            expect(screen.findByTestId(`${memoryTestID}.${firstSave}`)).toBeTruthy();
        });

        it.each(['error', 'locked', 'refused'] as const)('does not report a failed %s Project read as empty memory', async (status) => {
            storage.getState().clearProjectAccountRowsScope();
            storage.getState().activateProjectAccountRowsScope(scope);
            storage.getState().setProjectAccountRowsStatusForScope(scope, status);
            const screen = await renderScreen(<Body workspaceRef={workspaceRef} />);
            expect(screen.findByTestId(`${memoryTestID}.none`)).toBeNull();
            expect(screen.findByTestId(`${memoryTestID}.remember`)).toBeNull();
            expect(screen.findByTestId(`${memoryTestID}.unavailable`)).toBeTruthy();
        });
    });

    it('draws the personal Project layer: memory in its own section, documents as rows, an unreadable one without its title', async () => {
        const lockedArtifact: DecryptedArtifact = { id: 'gone-1', title: null, header: null, rawHeader: null,
            storageMode: 'e2ee', kindHint: 'prompt_doc.v2', isDecrypted: false, headerVersion: 1,
            createdAt: 1, updatedAt: 1, seq: 1, availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        storage.getState().applyArtifacts([lockedArtifact]);
        const screen = await renderScreen(<ProjectContextBody workspaceRef={workspaceRef} />);
        const rowTitle = (testID: string) => screen.findAllByTestId(testID).map((node) => node.props.title).find((title) => typeof title === 'string');

        // A Project with no Source has one layer: the viewer's own.
        expect(screen.findByTestId('project-context.shared.add')).toBeNull();
        expect(screen.findByTestId('project-context.personal.add')).toBeTruthy();
        expect(rowTitle('project-context.personal.guide-entry')).toBe('API style guide');

        // The memory document is the memory section's, never a second row in the list.
        expect(screen.findByTestId('project-context.personal.memory-entry')).toBeNull();
        expect(screen.findByTestId('project-context.memory.detach')).toBeTruthy();

        // A document this Account cannot read keeps its row and its Remove, but never a guessed title.
        await settled(() => expect(rowTitle('project-context.personal.gone-entry')).toBe('contextPages.project.privateDocument'));
        const actionIds = screen.findAllByType('ItemRowActions' as never).map((node) => (node.props.actions as { id: string }[]).map((action) => action.id));
        expect(actionIds).toContainEqual(['delete']);
        expect(actionIds).toContainEqual(['edit', 'moveUp', 'moveDown',
            'budget.all', 'budget.3000', 'budget.9000', 'budget.24000', 'delete']);
    });

    it('does not substitute personal memory for an unavailable Source-owned Project memory', async () => {
        const screen = await renderScreen(<ProjectContextBody workspaceRef={{ ...workspaceRef,
            source: { sourceId: 'source-1', revision: 1 },
        }} />);
        // Retained personal memory remains a personal document; it is not the Source's memory.
        expect(Boolean(screen.findByTestId('project-context.personal.memory-entry'))).toBe(true);
        expect(Boolean(screen.findByTestId('project-context.memory.detach'))).toBe(false);
        expect(Boolean(screen.findByTestId('project-context.memory.remember'))).toBe(false);
    });

    describe('attached document audience through the real Source and Artifact Actions', () => {
        async function attachOwnedDocument(options: Readonly<{
            grants?: ArtifactAccessGrantRowV1[];
            publicAudience?: 'none' | 'retained';
            rosterUnavailable?: boolean;
            headerOnly?: boolean;
        }>) {
            const serverId = await homes.addHome({ name: 'Project audience', serverUrl: 'https://project-audience.test',
                accountId: scope.accountId, teamsEnabled: true });
            const capturedScope = { serverId, accountId: scope.accountId };
            const settings = { ...settingsDefaults, actionsSettingsV1: { v: 1 as const, actions: {},
                approvalWaivedSurfaces: { 'projects.sources.update': ['ui' as const] } } };
            storage.setState({ settings, settingsScope: capturedScope, profileScope: capturedScope });
            homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 8 } });
            publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://project-audience.test', generation: 2 });
            const team = teamSummaryFixture();
            const directory = bindHomeDomainActionHttpRequestV1('teams.list', { v: 1, scope: 'member', archived: 'active', limit: 50, cursor: null });
            homes.answer(serverId, `${directory.method} ${directory.path}`, { body: { items: [team], nextCursor: null } });
            let source: ProjectSourceV1 = { id: 'audience-source', revision: 1, name: 'Happier',
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'happier/repo', visibility: 'private' }, protocol: 'https' },
                audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }], createdByAccountId: scope.accountId,
                attachments: [] };
            homes.answer(serverId, '/v1/projects/sources', { body: { ok: true, sources: [source], coverage: { complete: true, nextCursor: null } } });
            homes.answer(serverId, '/v1/projects/sources/audience-source', { select: (input, request) => {
                if (request.init?.method === 'PATCH') {
                    const patch = ProjectSourcesUpdateInputV1Schema.parse(input).patch;
                    if (patch.attachment?.kind === 'attach') source = { ...source, revision: source.revision + 1,
                        attachments: [...(source.attachments ?? []), patch.attachment.attachment] };
                }
                return { body: { ok: true, source, canManage: true } };
            } });
            const header = { v: 1, kind: 'prompt_doc.v2', title: 'API style guide' };
            const body = JSON.stringify({ v: 1, markdown: 'Use explicit names.', createdAtMs: 1, updatedAtMs: 1 });
            homes.artifacts(serverId).replaceStoredRow({ id: 'audience-doc', ownerAccountId: scope.accountId, access: 'owner',
                encryptionMode: 'plain', publicAudience: options.publicAudience ?? 'none', header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent({ body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1, seq: 1 });
            const { body: _catalogBody, ...catalogArtifact } = artifact('audience-doc', 'prompt_doc.v2', header.title);
            storage.getState().applyArtifacts([{ ...catalogArtifact,
                header, ...(options.headerOnly ? {} : { body }), publicAudience: options.publicAudience ?? 'none' }]);
            const roster = ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: 'audience-doc', ownerAccountId: scope.accountId,
                access: 'owner', grants: options.grants ?? [] });
            homes.answer(serverId, '/v1/artifacts/audience-doc/access/grants', options.rosterUnavailable
                ? { status: 403, body: { error: 'artifact_access_forbidden' } } : { body: roster });
            const screen = await renderScreen(<ProjectContextBody workspaceRef={{ ...workspaceRef, serverId,
                source: { sourceId: source.id, revision: 1 } }} />);
            await settled(() => {
                expect(screen.findByTestId('project-context.shared.add')).toBeTruthy();
                expect(screen.findAllByTestId('project-context.header').some(node =>
                    node.props.meta?.some((fact: { key: string }) => fact.key === 'team'))).toBe(true);
            });
            await screen.pressByTestIdAsync('project-context.shared.add');
            await act(async () => { screen.findByType(PromptStackDocumentMenu).props.onPick({ kind: 'doc', artifactId: 'audience-doc', serverId }, header.title); });
            await settled(() => expect(screen.findAll(node =>
                String(node.props.testID ?? '').startsWith('project-context.shared.') && node.props.title === header.title).length).toBeGreaterThan(0));
            await act(async () => {});
            return { screen, serverId };
        }

        it.each([
            ['target Team', { grants: [{ principal: { kind: 'team' as const, teamId: 'team-1' }, accessLevel: 'view' as const,
                createdByAccountId: scope.accountId, createdAt: 1, display: { name: 'Platform' } }] }],
            ['individual', { grants: [{ principal: { kind: 'account' as const, accountId: 'other-person' }, accessLevel: 'view' as const,
                createdByAccountId: scope.accountId, createdAt: 1, display: { name: 'Ada' } }] }],
            ['public', { publicAudience: 'retained' as const }],
            ['unknown roster', { rosterUnavailable: true }],
        ])('does not call an owned Doc only yours when its audience is %s', async (_name, options) => {
            const { screen } = await attachOwnedDocument(options);
            expect(screen.findByTestId('project-context.shareOffer')).toBeNull();
        });

        it('offers sharing for a confirmed private owned Doc whose picker catalog had only its header', async () => {
            const { screen } = await attachOwnedDocument({ headerOnly: true });
            await settled(() => expect(screen.findByTestId('project-context.shareOffer')).toBeTruthy());
        });

        it.each(['grant wake', 'credential replacement'] as const)('offers sharing for a confirmed private owned Doc until %s', async invalidation => {
            const { screen, serverId } = await attachOwnedDocument({});
            await settled(() => expect(screen.findByTestId('project-context.shareOffer')).toBeTruthy());
            if (invalidation === 'grant wake') {
                // A changed grant has no content revision; the existing Account wake retires the privacy claim.
                await act(async () => { publishHomeAccountChange(serverId, ['audience-doc'], { changeKinds: ['artifact'] }); });
                expect(screen.findByTestId('project-context.shareOffer')).toBeNull();
                return;
            }
            const credentials = await TokenStorage.getCredentialsForServerUrl('https://project-audience.test', { serverId });
            if (!credentials) throw new Error('Expected captured Home credential');
            // A real credential replacement also restores the Account connection and its lifetime.
            await homes.switchAccount(serverId, scope.accountId, { ...credentials, token: `${credentials.token}rotated` });
            // Team presentation must have recovered, so its temporary absence cannot hide a stale offer.
            await settled(() => {
                expect(screen.findAllByTestId('project-context.header').some(node =>
                    node.props.meta?.some((fact: { key: string }) => fact.key === 'team'))).toBe(true);
            });
            expect(screen.findByTestId('project-context.shareOffer')).toBeNull();
        });
    });
});
