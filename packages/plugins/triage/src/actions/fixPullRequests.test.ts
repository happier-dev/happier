import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    isExternalActionResultWithinResponseEnvelopeLimitV1,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import {
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TriageFixPullRequestV1Schema,
    TriageReadFixPullRequestsResultV1Schema,
    TriageConfiguredSourceInstanceV1Schema,
    TriageSourceDescriptorV1Schema,
    TriageSourceReadSessionLinksInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { deriveConfiguredSourceInstanceTag } from '../corpus/identity/tags.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE, CORPUS_USER_MARKS_INDEX_ID } from '../corpus/collections/ids.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
import { createTriageReadFixPullRequestsActionHandler, createTriageSetFixPullRequestActionHandler, readTriageFixPullRequests, setTriageFixPullRequest } from './fixPullRequests.js';
import { createTriageReobserveEntryActionHandler } from './reobserveEntry.js';
import { TriageReobserveEntryInputV1Schema, TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from './reobserveEntryProtocol.js';
import { createTriageReadEntryDetailActionHandler } from './readEntryDetail.js';
import { TriageReadEntryDetailInputV1Schema, TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from './entryDetailProtocol.js';
import { readTriageExactFixPullRequest } from '../ui/detail/useTriageDetailFixPullRequest.js';
import { readTriageEntryDetailState } from '../ui/detail/useTriageEntryDetail.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import { readInternalTaskSessionLinks } from '../internalTasks/source.js';

const fixture = createTriageSourceV1Fixture();
const pr = fixture.detailInput.observation.entryRef;
const error = { ...pr, source: { pluginId: 'happier.example.errors', localId: 'errors' }, kindId: 'error', entryId: 'error-1' };
const display = { title: 'Fix error', scopeLabel: 'example/repo' };
const errorConfigured = TriageConfiguredSourceInstanceV1Schema.parse({ ...fixture.configuredInstance,
    instance: { source: error.source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' } });
const errorSource = { contributor: { pluginId: error.source.pluginId, contributionId: error.source.localId },
    descriptor: TriageSourceDescriptorV1Schema.parse({ ...fixture.descriptor, kinds: [{ id: error.kindId, workflowSubject: 'errorIssue', displayName: 'Error' }] }),
    operations: {} };
function seedConfiguredFixSources(control: ReturnType<typeof createTestkitCorpusCollections>['control']) {
    for (const [index, configured] of [errorConfigured, fixture.configuredInstance].entries()) {
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: `${index}${'a'.repeat(42)}`,
            sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1000, configured }));
    }
}

describe('fix-PR public Action read', () => {
    it.each(['present', 'storedConfiguration', 'denied', 'configDenied', 'retired', 'nonPr', 'unselectedInstance', 'missing', 'stale'] as const)('reads selected native associations only under current source authority (%s)', async (mode) => {
        const { collections, control } = createTestkitCorpusCollections();
        const instanceTag = await deriveConfiguredSourceInstanceTag(collections.sourceInstances, {
            source: pr.source, binding: fixture.configuredInstance.binding, localInstanceKey: fixture.configuredInstance.localInstanceKey,
        });
        if (mode !== 'missing') control.sourceInstances.seed(toCorpusStoredValue({ instanceTag,
            sourceQualifiedId: `${pr.source.pluginId}/${pr.source.localId}`, lifecycle: mode === 'retired' ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1, configured: fixture.configuredInstance }));
        const finding = { ...pr, kindId: 'issue', entryId: 'native-finding' };
        for (let index = 0; index < 200; index++) control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: String(index).padStart(43, 'b'), sourceQualifiedId: 'happier.unrelated/source',
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            configured: { ...fixture.configuredInstance, instance: { source: { pluginId: 'happier.unrelated', localId: 'source' },
                sourceInstanceId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}` } },
        }));
        const sourceContext = { instance: { ...fixture.configuredInstance,
            ...(mode === 'stale' ? { localInstanceKey: 'no-longer-configured' } : {}),
            ...(mode === 'storedConfiguration' ? { configuration: { forged: true } } : {}),
            instance: { ...fixture.configuredInstance.instance,
                sourceInstanceId: mode === 'unselectedInstance' ? '33333333-3333-4333-8333-333333333333' : fixture.configuredInstance.instance.sourceInstanceId } },
            lastKnownLocator: fixture.detailInput.observation.locator };
        const configuredGets = vi.spyOn(collections.sourceInstances, 'get');
        if (mode === 'configDenied') configuredGets.mockRejectedValueOnce(new Error('Account read denied'));
        const configuredQueries = vi.spyOn(collections.sourceInstances, 'query');
        await linkEntryToSession({ collections, entryRef: pr, sessionId: 'unrelated-retained-session' as SessionId,
            nowMs: 1, display: { locator: fixture.detailInput.observation.locator, scopeLabel: 'Unrelated retained PR' } });
        const requests: unknown[] = [];
        // Targeted source dispatch and Account Collections are the real external boundaries.
        const context = { surface: 'agent', signal: new AbortController().signal, services: {
            storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => (
                definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances
                    : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks : collections.userMarks
            ) } },
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
                contributor: { pluginId: pr.source.pluginId, contributionId: pr.source.localId },
                descriptor: fixture.descriptor, operations: { get: { handle: 'get' }, readFixPullRequests: { handle: 'native' } },
            }] }), dispose: () => {} }) },
            actions: { executeAdmittedTargetedOperation: async (operation: unknown, input: unknown) => {
                requests.push({ operation, input });
                if ((operation as { handle: string }).handle === 'get') return fixture.getResult;
                return mode === 'denied' ? { kind: 'unavailable', failure: { class: 'permission', code: 'denied', requestId: 'fix-lookup-51' } }
                    : { kind: 'complete', candidates: [{ localRef: { ...fixture.getResult.localRef, ...(mode === 'nonPr' ? { kindId: 'issue' } : {}) }, status: 'open',
                        display, locator: fixture.detailInput.observation.locator }] };
            } },
        } } as unknown as PluginInvocationContext;
        const sourceReads = vi.spyOn(context.services.targetedContributions, 'observeForSelf');
        const result = TriageReadFixPullRequestsResultV1Schema.parse(await createTriageReadFixPullRequestsActionHandler()({
            v: 1, entryRef: finding, sourceContext,
        }, context));
        const present = mode === 'present' || mode === 'storedConfiguration';
        expect(sourceReads).toHaveBeenCalledTimes(1);
        expect(result.incomplete).toBe(!present);
        if (mode === 'denied') expect(result).toMatchObject({
            nativeFailure: { class: 'permission', code: 'denied', requestId: 'fix-lookup-51' },
        });
        expect(configuredQueries).not.toHaveBeenCalled();
        expect(configuredGets).toHaveBeenCalledTimes(1);
        expect(result.primary?.entryRef ?? null).toEqual(present ? pr : null);
        expect(requests).toEqual(['retired', 'unselectedInstance', 'missing', 'stale', 'configDenied'].includes(mode) ? [] : [{ operation: { handle: 'native' }, input: { v: 1, instance: fixture.configuredInstance,
            localRef: { kindId: finding.kindId, collisionScope: finding.collisionScope, entryId: finding.entryId },
            lastKnownLocator: sourceContext.lastKnownLocator } }]);
        if (present) {
            configuredGets.mockClear();
            const host = { executeAction: async (action: string, input: unknown) => {
                if (action === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) return await createTriageReobserveEntryActionHandler()(
                    TriageReobserveEntryInputV1Schema.parse(input), context);
                if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) return await createTriageReadEntryDetailActionHandler()(
                    TriageReadEntryDetailInputV1Schema.parse(input), context);
                throw new Error(`Unexpected Action ${action}`);
            } };
            const selected = await readTriageExactFixPullRequest(host, result.primary!);
            expect(selected?.observation.entryRef).toEqual(pr);
            expect(configuredGets).toHaveBeenCalledTimes(1);
            expect(configuredQueries).not.toHaveBeenCalled();
            expect(requests.at(-1)).toEqual({ operation: { handle: 'get' }, input: fixture.getInput });
            if (selected === null) throw new Error('Expected the native PR exact selection');
            configuredGets.mockClear();
            const detail = await readTriageEntryDetailState(host, {
                selection: { entryRef: pr, sourceInstanceId: selected.sourceInstanceId, sourceInstanceRowId: selected.sourceInstanceRowId },
                observation: selected.observation,
            });
            expect(detail).toMatchObject({ kind: 'ready', input: { instance: fixture.configuredInstance,
                observation: selected.observation } });
            expect(configuredGets).toHaveBeenCalledTimes(1);
            expect(configuredQueries).not.toHaveBeenCalled();
        }
        expect(result.candidates).toEqual(present ? [{ entryRef: pr, origins: ['native'], status: 'open', display,
            sourceContext: { sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId, sourceInstanceRowId: instanceTag,
                lastKnownLocator: sourceContext.lastKnownLocator } }] : []);
        expect((await collections.userMarks.query({ index: CORPUS_USER_MARKS_INDEX_ID.byPinned, order: 'asc' })).rows).toHaveLength(0);
    });
    it('fits whole derived candidates at the real Action envelope while preserving explicit links and the full local read', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        seedConfiguredFixSources(control);
        await setTriageFixPullRequest({ v: 1, linked: true, entryRef: error, displayAtMark: display,
            fixPullRequest: pr, displayAtLink: display }, { collections, nowMs: () => 1_000 });
        const displayPath = '"'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
        const candidate = TriageFixPullRequestV1Schema.parse({
            entryRef: { ...pr, collisionScope: '\\'.repeat(MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1),
                entryId: '000000' + '"'.repeat(MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1 - 6) },
            origins: ['session'], status: 'unknown',
            display: { displayPath },
        });
        const candidateBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1([candidate])
            - measureExternalActionResultResponseEnvelopeUtf8BytesV1([]);
        const count = Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / candidateBytes) + 1;
        const siblingsPerSession = MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 - 1;
        const sessionCount = Math.ceil(count / siblingsPerSession);
        expect(sessionCount).toBeLessThanOrEqual(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1);
        for (let index = 0; index < count; index += 1) {
            const sessionId = `fixture-session-${Math.floor(index / siblingsPerSession)}` as SessionId;
            if (index % siblingsPerSession === 0) {
                expect((await linkEntryToSession({ collections, entryRef: error, sessionId, nowMs: 1,
                    display: { locator: fixture.detailInput.observation.locator, scopeLabel: display.scopeLabel } })).status).toBe('linked');
            }
            expect((await linkEntryToSession({ collections,
                entryRef: { ...candidate.entryRef, entryId: String(index).padStart(6, '0') + '"'.repeat(MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1 - 6) },
                sessionId, nowMs: 2_000 + index,
                display: { locator: { v: 1, displayPath }, scopeLabel: display.scopeLabel },
            })).status).toBe('linked');
        }
        // Only Account storage and the admitted descriptor transport are replaced.
        // No configured provider connection is needed to retain unknown PRs.
        const internalRead = { role: 'internalRead' };
        const context = {
            surface: 'agent',
            signal: new AbortController().signal,
            services: {
                actions: {
                    execute: async (action: string) => {
                        if (action !== 'tasks.internal.list') throw new Error(`Unexpected host Action ${action}`);
                        return { status: 'ok', scope: { serverId: 'home', accountId: 'account' }, todos: [], undoneOrder: [], completedOrder: [] };
                    },
                    executeAdmittedTargetedOperation: async (operation: unknown, input: unknown) => {
                        expect(operation).toBe(internalRead);
                        return readInternalTaskSessionLinks(TriageSourceReadSessionLinksInputV1Schema.parse(input),
                            context as Parameters<typeof readInternalTaskSessionLinks>[1]);
                    },
                },
                storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => (
                    definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances
                        : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks : collections.userMarks
                ) } },
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => ({ contributions: [errorSource, {
                        contributor: { pluginId: pr.source.pluginId, contributionId: pr.source.localId },
                        descriptor: fixture.descriptor, operations: {},
                    }, {
                        contributor: { pluginId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.source.pluginId,
                            contributionId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.source.localId },
                        descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
                        operations: { readSessionLinks: internalRead, linkSession: { role: 'internalWrite' } },
                    }] }), dispose: () => {},
                }) },
            },
        } as unknown as PluginInvocationContext;
        const local = TriageReadFixPullRequestsResultV1Schema.parse(await readTriageFixPullRequests({ v: 1, entryRef: error }, {
            collections, nowMs: () => 3_000, sourceRelations: createTriageSourceSessionRelations(context, collections),
            projection: {
                workflowSubjectOf: (ref) => fixture.descriptor.kinds.find((kind) => kind.id === ref.kindId)?.workflowSubject ?? null,
                presentationOf: () => null,
            },
        }));
        expect(local.candidates).toHaveLength(count + 1);
        expect(local.incomplete).toBe(false);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(local)).toBe(false);
        const result = TriageReadFixPullRequestsResultV1Schema.parse(await createTriageReadFixPullRequestsActionHandler()({ v: 1, entryRef: error }, context));
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
        expect(result.incomplete).toBe(true);
        expect(result.candidates[0]?.entryRef).toEqual(pr);
        expect(result.primary?.entryRef).toEqual(pr);
        expect(result.candidates).toEqual(local.candidates.slice(0, result.candidates.length));
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1({
            ...result, candidates: local.candidates.slice(0, result.candidates.length + 1),
        })).toBe(false);
        // Real Collection links plus repeated complete 24 MB envelope measures
        // took 30s in this harness; use the maximal-envelope lane's 60s budget.
    }, 60_000);

    it('resolves lifecycle through the current configured source and admitted get, without exposing mark storage', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        seedConfiguredFixSources(control);
        await setTriageFixPullRequest({ v: 1, linked: true, entryRef: error, displayAtMark: display,
            fixPullRequest: pr, displayAtLink: display }, { collections, nowMs: () => 1000 });
        const requests: unknown[] = [];
        const controller = new AbortController();
        let disposed = false;
        // Host context, Account persistence, admission and provider dispatch are system boundaries.
        const context = {
            surface: 'agent', signal: controller.signal,
            services: {
                storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => (
                    definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances
                        : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks : collections.userMarks
                ) } },
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => ({ contributions: [errorSource, {
                        contributor: { pluginId: pr.source.pluginId, contributionId: pr.source.localId },
                        descriptor: fixture.descriptor, operations: { get: { handle: 'admitted-get' } },
                    }] }),
                    dispose: () => { disposed = true; },
                }) },
                actions: { executeAdmittedTargetedOperation: async (operation: unknown, input: unknown, options: { signal?: AbortSignal }) => {
                    requests.push({ operation, input });
                    expect(options.signal?.aborted).toBe(false);
                    return { ...fixture.getResult, snapshot: { ...fixture.detailInput.observation.snapshot,
                        state: { ...fixture.detailInput.observation.snapshot.state, presentation: 'closed' } } };
                } },
            },
        } as unknown as PluginInvocationContext;
        const result = TriageReadFixPullRequestsResultV1Schema.parse(await createTriageReadFixPullRequestsActionHandler()({
            v: 1, entryRef: error,
        }, context));
        expect(result).toEqual({ v: 1, candidates: [{ entryRef: pr, origins: ['user'], status: 'closed', display }], primary: null, incomplete: false });
        expect(requests).toEqual([{ operation: { handle: 'admitted-get' }, input: {
            v: 1, instance: fixture.configuredInstance,
            localRef: { kindId: pr.kindId, collisionScope: pr.collisionScope, entryId: pr.entryId },
        } }]);
        expect(disposed).toBe(true);
    });

    it('rejects a currently declared issue target through the write Action without invoking a provider', async () => {
        const { collections } = createTestkitCorpusCollections();
        const issue = { ...pr, kindId: 'issue' };
        let disposed = false;
        // Only Account storage and the host's admitted descriptor snapshot are substituted.
        const context = {
            surface: 'agent',
            services: {
                storage: { account: { collection: () => collections.userMarks } },
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => ({ contributions: [{
                        contributor: { pluginId: pr.source.pluginId, contributionId: pr.source.localId },
                        descriptor: fixture.descriptor, operations: {},
                    }] }),
                    dispose: () => { disposed = true; },
                }) },
                actions: { executeAdmittedTargetedOperation: async () => { throw new Error('Writes do not read the provider'); } },
            },
        } as unknown as PluginInvocationContext;
        await expect(createTriageSetFixPullRequestActionHandler()({
            v: 1, linked: true, entryRef: error, displayAtMark: display, fixPullRequest: issue, displayAtLink: display,
        }, context)).rejects.toMatchObject({ name: 'PluginError', code: 'triage_fix_pull_request_kind_invalid' });
        expect((await collections.userMarks.query({ index: CORPUS_USER_MARKS_INDEX_ID.byPinned, order: 'asc' })).rows).toHaveLength(0);
        expect(disposed).toBe(true);
    });

    it('preserves link and unlink intent when admitted source facts cannot be reached', async () => {
        const { collections } = createTestkitCorpusCollections();
        const context = {
            surface: 'agent',
            services: {
                storage: { account: { collection: () => collections.userMarks } },
                // The host descriptor-read boundary is unavailable, not evidence of a non-PR kind.
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => { throw new Error('Admitted source view unavailable'); },
                    dispose: () => {},
                }) },
            },
        } as unknown as PluginInvocationContext;
        const handler = createTriageSetFixPullRequestActionHandler();
        const input = { v: 1 as const, entryRef: error, displayAtMark: display, fixPullRequest: pr };
        await expect(handler({ ...input, linked: true, displayAtLink: display }, context)).resolves.toEqual({ v: 1, status: 'linked' });
        await expect(handler({ ...input, linked: false }, context)).resolves.toEqual({ v: 1, status: 'unlinked' });
    });

    it('reads a durable explicit choice as unknown when the admitted view is unavailable', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: 'a'.repeat(43), sourceQualifiedId: `${pr.source.pluginId}/${pr.source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1000, configured: fixture.configuredInstance,
        }));
        await setTriageFixPullRequest({ v: 1, linked: true, entryRef: error, displayAtMark: display,
            fixPullRequest: pr, displayAtLink: display }, { collections, nowMs: () => 1000 });
        const context = {
            surface: 'agent',
            services: {
                storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => (
                    definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances
                        : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks : collections.userMarks
                ) } },
                // Only the host's admitted-view read fails; durable Account storage stays reachable.
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => { throw new Error('Admitted source view unavailable'); },
                    dispose: () => {},
                }) },
                actions: { executeAdmittedTargetedOperation: async () => { throw new Error('Unavailable facts cannot authorize a provider read'); } },
            },
        } as unknown as PluginInvocationContext;
        const result = await createTriageReadFixPullRequestsActionHandler()({ v: 1, entryRef: error }, context);
        expect(result.primary).toMatchObject({ entryRef: pr, origins: ['user'], status: 'unknown', display });
        expect(result.candidates).toEqual([result.primary]);
        expect(result.incomplete).toBe(true);
    });
});
