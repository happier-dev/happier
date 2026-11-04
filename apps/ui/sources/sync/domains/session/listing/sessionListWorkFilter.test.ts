import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1, matchSessionListFilterV1, matchSessionProjectFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { listSessionPresentationStatesForWorkStatusFilterV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { createSessionFixture, createSessionListRenderableSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { buildSessionListRenderableFromSession, preserveSessionListRenderableStaleFields } from './sessionListRenderable';
import { buildSessionListRowFilterFacts, buildWorkflowRunFilterFacts, matchSessionListRowLocalFilter, matchWorkflowRunSessionListFilter } from './sessionListWorkFilter';

describe('held Session filter facts', () => {
    it('keeps malformed owner branch metadata unavailable', () => {
        const row = createSessionFixture({ metadata: { host: 'dev', path: '/repo', branch: { name: 'main' } } });
        expect(buildSessionListRowFilterFacts(row, 'home', { nowMs: 1 })).not.toHaveProperty('branch');
    });
    it('does not broaden explicit empty Home or starter selections through ordinary-list admission', () => {
        const row = createSessionListRenderableSessionFixture({ metadata: { path: '/repo' } });
        const base = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        expect(matchSessionListRowLocalFilter(row, 'home', { ...base, startedBy: [] }, { nowMs: 1 })).toBe('miss');
        expect(matchSessionListRowLocalFilter(row, 'home', { ...base, homeServerIds: [] }, { nowMs: 1 })).toBe('miss');
        expect(matchWorkflowRunSessionListFilter(createWorkflowRunSummaryFixture({ attentionRequired: true }), 'home',
            { ...base, startedBy: [] })).toBe('miss');
    });
    it('withholds viewer-private Project refs from keyless recipients and foreign-Home rows while accepting published keys', () => {
        const refs = ['home', 'foreign'].map(serverId => ({ id: 'checkout', serverId, machineId: 'machine',
            rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 }));
        const row = createSessionListRenderableSessionFixture({ metadataLayoutVersion: 0, ownerAccountId: 'viewer',
            metadata: { workspaceId: 'checkout', machineId: 'machine', path: '/repo' } });
        const recipient = { ...row, ownerAccountId: 'other', access: createSessionAccessFixture('view'), accessLevel: 'view' as const };
        const options = { nowMs: 1, viewerAccountId: 'viewer', workspaceRefs: refs, workspaceRefsServerId: 'home',
            sessionProjectKeyResolver: createSessionProjectKeyResolverV1(refs) };
        const matchProject = (candidate: typeof row, serverId: string, overrides: Partial<typeof options> = {}) => {
            const facts = buildSessionListRowFilterFacts(candidate, serverId, { ...options, ...overrides });
            return matchSessionProjectFilterV1(facts.projectMetadata, serverId, { serverId, projectKey: 'anchor' },
                facts.workspaceRefs, { ...facts.workspaceContext, projectKey: facts.projectKey });
        };
        expect(matchProject(recipient, 'home')).toBe('unavailable');
        expect(matchProject(row, 'home')).toBe('match');
        expect(matchProject(row, 'foreign')).toBe('unavailable');
        expect(matchProject({ ...row, ownerAccountId: 'other' }, 'home')).toBe('unavailable');
        expect(matchProject({ ...row, ownerAccountId: undefined, access: undefined, accessLevel: undefined }, 'home')).toBe('unavailable');
        expect(matchProject(row, 'home', { viewerAccountId: undefined })).toBe('unavailable');
        // 0.2 HEAD 413054f V2 mapper emits share:null for own rows, no ownerAccountId.
        const legacyOwner = normalizeSessionAccessProjection({ share: null }, { allowLegacy: true });
        const legacyRecipient = normalizeSessionAccessProjection({ share: { accessLevel: 'view', canApprovePermissions: false } }, { allowLegacy: true });
        expect(matchProject({ ...row, ownerAccountId: undefined, access: legacyOwner }, 'home')).toBe('match');
        expect(matchProject({ ...row, ownerAccountId: undefined, access: legacyRecipient }, 'home')).toBe('unavailable');
        expect(matchProject({ ...row, ownerAccountId: '', access: legacyOwner }, 'home')).toBe('unavailable');
        expect(matchProject({ ...recipient, projectKey: 'anchor' }, 'home')).toBe('match');
        expect(matchProject({ ...row, projectKey: 'anchor' }, 'foreign')).toBe('match');
    });
    it('admits a genuine owner through a saved Home alias without changing Project qualification', async () => {
        const canonicalHome = 'srv_project-census-admission';
        const profile = await setServerProfileIdentityForUrl('http://project-census-admission.test', canonicalHome);
        expect(profile).not.toBeNull();
        if (!profile) throw new Error('Home fixture was not admitted');
        expect(profile.id).not.toBe(canonicalHome);
        const refs = [{ id: 'checkout', serverId: canonicalHome, machineId: 'machine', rootPath: '/repo',
            projectKey: 'anchor', createdAtMs: 1 }];
        const row = createSessionListRenderableSessionFixture({ ownerAccountId: 'viewer',
            metadata: { workspaceId: 'checkout', machineId: 'machine', path: '/repo' } });
        const context = workspaceRefResolutionContextV1();
        const facts = buildSessionListRowFilterFacts(row, profile.id, { nowMs: 1, viewerAccountId: 'viewer',
            workspaceRefs: refs, workspaceRefsServerId: canonicalHome,
            sessionProjectKeyResolver: createSessionProjectKeyResolverV1(refs, context) });
        expect(matchSessionProjectFilterV1(facts.projectMetadata, profile.id, { serverId: canonicalHome, projectKey: 'anchor' },
            facts.workspaceRefs, facts.workspaceContext)).toBe('match');
    });

    it('uses admitted machine, Agent, owner and update facts without treating search text as stored narrowing', () => {
        const row = buildSessionListRenderableFromSession(createSessionFixture({ ownerAccountId: 'me', updatedAt: 20,
            origin: { kind: 'none' }, metadata: { host: 'dev', path: '/repo', machineId: 'm', flavor: 'codex' } }), undefined, []);
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
            machines: { include: [{ serverId: 'home', machineId: 'm' }], exclude: [] },
            agents: { include: [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })], exclude: [] },
            owners: { include: [{ serverId: 'home', accountId: 'me' }], exclude: [] },
            updated: { op: 'after', atMs: 10 } });
        const options = { nowMs: 30, viewerAccountId: 'me' };
        expect(buildSessionListRowFilterFacts(row, 'home', options)).toMatchObject({
            machine: { serverId: 'home', machineId: 'm' }, agent: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
            owner: { serverId: 'home', accountId: 'me' }, updatedAt: 20,
        });
        const filterWithTransientSearch = { ...filter, searchQuery: 'local text' };
        expect(matchSessionListRowLocalFilter(row, 'home', filterWithTransientSearch, options)).toBe('match');
        expect(matchSessionListFilterV1(filter, buildSessionListRowFilterFacts({ ...row, metadataUnavailable: true }, 'home', options))).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, buildSessionListRowFilterFacts(row, 'other', options))).toBe('miss');
    });

    it('uses qualified held Section assignments and distinguishes unknown from known unfiled', () => {
        const row = createSessionListRenderableSessionFixture({ metadata: { path: '/repo' } });
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
            sections: { include: [{ serverId: 'home', sectionId: 'section' }], exclude: [] } });
        const section = { serverId: 'home', sectionId: 'section' };
        expect(buildSessionListRowFilterFacts(row, 'home', { nowMs: 1, section })).toMatchObject({ section });
        expect(matchSessionListRowLocalFilter(row, 'home', filter, { nowMs: 1, section })).toBe('match');
        expect(matchSessionListRowLocalFilter(row, 'home', filter, { nowMs: 1, section: null })).toBe('miss');
        expect(matchSessionListRowLocalFilter(row, 'home', filter, { nowMs: 1 })).toBe('unavailable');
    });

    it('uses only admitted owner Branch facts and distinguishes detached from unavailable', () => {
        const row = buildSessionListRenderableFromSession(createSessionFixture({
            metadata: { host: 'dev', path: '/repo', branch: 'main' },
        }), undefined, []);
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
            branches: { include: ['main'], exclude: [] } });
        expect(buildSessionListRowFilterFacts(row, 'home', { nowMs: 1 }).branch).toBe('main');
        expect(matchSessionListRowLocalFilter(row, 'home', filter, { nowMs: 1 })).toBe('match');
        expect(matchSessionListRowLocalFilter({ ...row, metadata: { ...row.metadata!, branch: null } }, 'home', filter,
            { nowMs: 1 })).toBe('miss');
        expect(matchSessionListRowLocalFilter({ ...row, metadata: { path: '/repo' } }, 'home', filter,
            { nowMs: 1 })).toBe('unavailable');
        expect(matchSessionListRowLocalFilter({ ...row, metadataUnavailable: true }, 'home', filter,
            { nowMs: 1 })).toBe('unavailable');
    });

    it('reads Run owner and updated time from its held row without inferring Session workspace facts', () => {
        const run = createWorkflowRunSummaryFixture({ ownerAccountId: 'me', updatedAt: '2026-10-23T10:00:00.000Z' });
        expect(buildWorkflowRunFilterFacts(run, 'home', 'me')).toMatchObject({
            owner: { serverId: 'home', accountId: 'me' }, updatedAt: Date.parse(run.updatedAt),
        });
        expect(buildWorkflowRunFilterFacts(run, 'home', 'me')).not.toHaveProperty('machine');
        expect(buildWorkflowRunFilterFacts(run, 'home', 'me')).not.toHaveProperty('branch');
    });

    it('matches canonical Session and Run statuses including failure, hold, stopping and offline with exclusions', () => {
        const base = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible', startedBy: ['you', 'triggers', 'agents'] });
        const cases = [
            { expected: 'failed', group: 'failed', run: createWorkflowRunSummaryFixture({ startedBy: 'trigger', state: 'failed', failureUnseen: true, attentionRequired: true }) },
            { expected: 'waiting_for_review', group: 'needs_you', run: createWorkflowRunSummaryFixture({ startedBy: 'trigger', state: 'waiting_for_review', attentionRequired: true,
                invocationAttentionRequired: true }) },
            { expected: 'stopping', group: 'working', run: createWorkflowRunSummaryFixture({ startedBy: 'trigger', state: 'cancelled', workflowCustodyState: 'pending' }) },
        ] as const;
        for (const { expected, group, run } of cases) {
            expect(buildWorkflowRunFilterFacts(run, 'home').status).toBe(expected);
            expect(matchWorkflowRunSessionListFilter(run, 'home', { ...base, statuses: [expected] })).toBe('match');
            expect(matchWorkflowRunSessionListFilter(run, 'home', { ...base, excludedStatuses: [expected] })).toBe('miss');
            const statuses = listSessionPresentationStatesForWorkStatusFilterV1(group);
            expect(matchWorkflowRunSessionListFilter(run, 'home', { ...base, statuses })).toBe('match');
            expect(matchWorkflowRunSessionListFilter(run, 'home', { ...base, excludedStatuses: statuses })).toBe('miss');
        }
        expect(matchWorkflowRunSessionListFilter(cases[1].run, 'home', { ...base, statuses: ['permission_required'] })).toBe('miss');
        const offline = createSessionListRenderableSessionFixture({ active: false, presence: 0, metadata: { path: '/repo' } });
        expect(buildSessionListRowFilterFacts(offline, 'home', { nowMs: 1 }).status).toBe('disconnected');
        expect(matchSessionListRowLocalFilter(offline, 'home', { ...base, statuses: ['disconnected'] }, { nowMs: 1 })).toBe('match');
        expect(matchSessionListRowLocalFilter(offline, 'home', { ...base, excludedStatuses: ['disconnected'] }, { nowMs: 1 })).toBe('miss');
    });

    it('keeps configured Agent target identity through the admitted compact row', () => {
        const target = { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'configured-one' };
        const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1,
            sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'test', creationKey: 'configured' }),
            recipe: { execution: { machineId: 'm', directory: { kind: 'path', path: '/repo' } },
                organization: { folderId: null, tagIds: [] }, agentTarget: target,
                modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
                configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
                terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null },
        });
        const session = createSessionFixture({ metadata: { host: 'dev', path: '/repo', machineId: 'm', sessionCreationCorrespondenceV1: correspondence } });
        const compact = buildSessionListRenderableFromSession(session, undefined, []);
        const expected = buildBackendTargetKeyV2(target);
        expect(buildSessionListRowFilterFacts(compact, 'home', { nowMs: 1 }).agent).toBe(expected);
        expect(matchSessionListRowLocalFilter(compact, 'home', normalizeSessionListFilterV1({
            homeServerIds: ['home'], scope: 'all_accessible', agents: { include: [expected], exclude: [] },
        }), { nowMs: 1 })).toBe('match');
        expect(buildSessionListRowFilterFacts(session, 'home', { nowMs: 1 }).agent).toBe(expected);
        expect(buildSessionListRenderableFromSession(session, compact, [])).toBe(compact);
        const transient = buildSessionListRenderableFromSession({ ...session, metadata: null }, compact, []);
        expect(buildSessionListRowFilterFacts(transient, 'home', { nowMs: 1 }).agent).toBe(expected);
        const ownerSession = { ...session, metadata: null, metadataLayoutVersion: 1, ownerMetadataView: session.metadata };
        const ownerCompact = buildSessionListRenderableFromSession(ownerSession, undefined, []);
        expect(ownerCompact.agentTargetKey).toBe(expected);
        const locked = buildSessionListRenderableFromSession({ ...ownerSession, ownerMetadataView: null }, ownerCompact, []);
        expect(locked.agentTargetKey).toBeNull();
        expect(locked.metadataUnavailable).toBe(true);
        expect(buildSessionListRowFilterFacts(locked, 'home', { nowMs: 1 })).not.toHaveProperty('agent');
        const replacementTarget = { ...target, definitionId: 'configured-two' };
        const updated = buildSessionListRenderableFromSession({ ...session, metadataVersion: session.metadataVersion + 1,
            metadata: { ...session.metadata!, sessionCreationCorrespondenceV1: { ...correspondence,
                recipe: { ...correspondence.recipe, agentTarget: replacementTarget } } } }, compact, []);
        expect(updated).not.toBe(compact);
        expect(buildSessionListRowFilterFacts(updated, 'home', { nowMs: 1 }).agent).toBe(buildBackendTargetKeyV2(replacementTarget));
        expect(buildSessionListRowFilterFacts(preserveSessionListRenderableStaleFields(updated, compact), 'home', { nowMs: 1 }).agent)
            .toBe(buildBackendTargetKeyV2(replacementTarget));
        expect(buildSessionListRowFilterFacts({ ...compact, metadataUnavailable: true }, 'home', { nowMs: 1 })).not.toHaveProperty('agent');
        expect(buildSessionListRowFilterFacts(createSessionListRenderableSessionFixture({
            metadata: { path: '/repo', flavor: 'undeclared-agent' },
        }), 'home', { nowMs: 1 })).not.toHaveProperty('agent');
    });
});
