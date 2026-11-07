// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { matchWorkspaceRoutePatterns } from '../../../../../apps/ui/sources/components/appShell/workspace/workspaceRouteMatch.js';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { createPluginClientTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit, PluginUiTestkitExecuteActionInput } from '@happier-dev/plugin-sdk/testing';
import type { PluginClientActionUi } from '@happier-dev/plugin-sdk/actions';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { PluginActionContributionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { Button, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import type { PluginUiDataClient, PluginUiAccountCollectionForDefinition } from '@happier-dev/plugin-ui/data';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { useTriageEntryDetail, type TriageEntryDetailInputSourceV1 } from './detail/useTriageEntryDetail.js';
import { useTriageFixPullRequests } from './detail/useTriageFixPullRequests.js';
import { useTriageActions } from './actions/useTriageActions.js';
import { useTriageSavedViews } from './views/useTriageSavedViews.js';
import { useTriagePinnedEntries } from './marks/useTriagePinnedEntries.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from '../settings/savedViews.js';
import { readTriageActionsForSurface } from '../actions/actionsCatalog.js';
import { readTriageSavedViewsForSurface } from '../actions/savedViews.js';
import { TriageReadActionsInputV1Schema } from '../actions/actionsCatalogProtocol.js';
import { TriageReadSavedViewsInputV1Schema } from '../actions/savedViewsProtocol.js';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailInstance, useTriagePostMutationCompletion, useTriageEvidenceDisclosure, type TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';
import { PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 } from '@happier-dev/plugin-sdk/ui';
import {
    formatTriageTimestampV1,
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageDetailSurfaceInputV1JsonSchema,
    TriageDetailSurfaceInputV1Schema,
    TriageEntryRefV1Schema,
    admitTriageSourceDescriptorV1,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanResultV1,
    type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiContextEnrichmentV1, PluginUiPageNavigationV1 } from '@happier-dev/plugin-sdk/ui';
import { TriageMountedUiInputV1Schema } from '../actions/mountedUiProtocol.js';
import { TriageEditTaskActionInputV1Schema, TriageTaskDraftV1Schema } from '../actions/tasksProtocol.js';
import { TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, type TriageTaskOriginErrorV1Schema } from '../actions/taskOriginProtocol.js';
import { unlinkEntryFromSession } from '../sessions/entrySessionLinks.js';
import { TriageUnlinkEntryFromSessionActionInputV1Schema, TriageUnlinkEntryFromSessionActionResultV1Schema } from '../actions/entrySessionProtocol.js';
import { invokeTriageMountedUiAction } from './mountedActions.js';
import { activate as activateMountedUi } from '../actions/mountedUi.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

import type { JsonValue } from '@happier-dev/plugin-sdk';

import { TriageReadEntryDetailInputV1Schema } from '../actions/entryDetailProtocol.js';
import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../actions/entryDetailProtocol.js';
import {
    TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
    TriageReobserveEntryInputV1Schema,
} from '../actions/reobserveEntryProtocol.js';
import { readTriageEntryDetail } from '../actions/readEntryDetail.js';
import { createTestkitSourceSessionRelations, readTestkitSourceSessionLinks } from '../sessions/testkit/entrySessionTestkit.test-support.js';
import { listTriagePinnedEntries, setTriageEntryPinned } from '../actions/userMarks.js';
import { reobserveTriageEntry } from '../actions/reobserveEntry.js';
import { findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import { toTriageWireObservation } from '../projection/listWindowWire.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
    TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    TriageSetEntryPinnedInputV1Schema,
} from '../actions/userMarksProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { fromCorpusStoredRow, toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1, CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag } from '../corpus/identity/tags.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { buildTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import {
    TRIAGE_ROUTE_DEFAULT_LENS_V1,
    buildTriageRouteSubPathV1,
} from './navigation/location.js';
import { TRIAGE_SHELL_FILL_TEST_ID_V1, TRIAGE_SHELL_DETAIL_REGION_TEST_ID_V1 } from './shell/root.js';
import { TRIAGE_TASK_PROPERTIES_TEST_ID_V1, TRIAGE_TASK_TEXT_EDITOR_TEST_ID_V1 } from './detail/taskFields.js';
import { TRIAGE_TASK_STORY_TEST_ID_V1 } from './detail/taskStory.js';
import { readTriageListWindowSnapshot, refreshTriageListWindow } from './window/mountedWindow.js';
import { renderSurface as renderShellSurface } from './surface.js';
import { renderSurface as renderTasksSurface } from './tasksSurface.js';
import { renderSurface as renderEntrySessionCompanion } from './detail/sessionCompanion.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';
import { createTriageEphemeralSharedScopeFixture, createTriageEphemeralSharedScopeOriginFixture } from './window/ephemeralSharedScope.test-support.js';
import { useTriageListWindow } from './window/useTriageListWindow.js';
import { useTriageListWindowViewDemand } from './window/useTriageListWindowViewDemand.js';
import { usePersonalTaskOrder } from './list/usePersonalTaskOrder.js';
import { useGithubOverview } from '../../../scm-github/src/ui/detail/panelReaders.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../../scm-github/src/triage/contribution.js';
import { GithubOverviewResultV1Schema } from '../../../scm-github/src/triage/detail/contracts.js';
import { GithubSecurityAlertBody } from '../../../scm-github/src/ui/securityAlerts/detail.js';
import { GITHUB_SECURITY_ALERT_ACTION_IDS_V1, GithubSecurityAlertReadResultV1Schema } from '../../../scm-github/src/triage/securityAlerts/actionContracts.js';

/**
 * Opening a row all the way into the source's own detail body.
 *
 * `TargetedSurface` had exactly one appearance in the whole aggregate — a
 * comment saying it was not mounted — so every packaged source detail renderer
 * was unreachable and a reader could see rows and open none of them. This case
 * drives the real vertical: the real shell, the real selection reducer, the real
 * `entries/read-detail-v1` handler over real Collections, the real strict input
 * builder, the real `TargetedSurface`, and the host's own admission projection,
 * which validates the launch input against the PUBLISHED detail role schema
 * before any child is rendered.
 *
 * The contributor is a fixture source rather than a first-party one on purpose:
 * what is being proved is the aggregate's half of the seam, and a fixture keeps
 * the case from passing because one particular forge happens to be packaged.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';

/**
 * A SECOND configured connection to the same source, sorted after the first.
 *
 * One entry observed by two of the reader's own accounts is ordinary — a public
 * pull request both of them can see — and the corpus's instance selector breaks
 * that tie deterministically by the smaller id. So the window's own answer for
 * this entry is always `INSTANCE`, which is what makes "the launch's connection
 * won" falsifiable: with one configured connection, honouring the launch and
 * ignoring it are the same code.
 */
const SECOND_INSTANCE = '22222222-2222-4222-8222-222222222222';
const OTHER_INSTANCE = '33333333-3333-4333-8333-333333333333';
const CONTRIBUTOR_GENERATION = 'contributor-generation-a';
const TARGET_GENERATION = 'target-generation-a';
const DETAIL_RENDERER_ID = 'example-detail';
const DETAIL_BODY_TEXT = 'The example forge detail body';
/**
 * One entry whose canonical reference is as large as the contract allows.
 *
 * `MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1` is 192 bytes and
 * `MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1` is 128, and percent-encoding triples a
 * non-Latin byte — so a perfectly ordinary entry from a non-Latin repository
 * produces a selection segment of ~750 route bytes on its own. That is what
 * makes §3.2's refusal reachable by a reader rather than only by a hand-edited
 * URL, and it is why the fixture carries a real one instead of padding a short
 * reference out with filler.
 */
const LONG_SCOPE = '設'.repeat(64);
const LONG_ENTRY_ID = '9'.repeat(128);
const LONG_REF_ROW_TITLE = 'An entry with a very long canonical reference';
/** Long enough to pad a location to the bound; bounded by the wire's 512 bytes. */
const SUMMARY_PADDING = 'x'.repeat(512);
const PROTOCOL = Object.freeze({
    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
});
const DESCRIPTOR = Object.freeze({
    v: 1,
    purpose: 'triage-source',
    displayName: 'Example forge',
    kinds: [{
        id: 'pull-request',
        workflowSubject: 'pullRequest',
        displayName: 'Pull request',
        pluralDisplayName: 'Pull requests',
    }],
});
const TASK_DESCRIPTOR = { ...DESCRIPTOR, kinds: DESCRIPTOR.kinds.map(kind => ({ ...kind, task: true,
    taskCapabilities: { editFields: ['title', 'body', 'dueDate'] } })) };

/** The contributor's real public manifest, as the host reads it at admission. */
const CONTRIBUTOR_MANIFEST = definePlugin({
    id: SOURCE.pluginId,
    version: '1.0.0',
    ui: {
        renderers: [{
            id: DETAIL_RENDERER_ID,
            kind: 'declarative',
            root: { kind: 'text', text: DETAIL_BODY_TEXT },
        }],
    },
}).manifest;

const CONTRIBUTOR = Object.freeze({
    pluginId: SOURCE.pluginId,
    contributionId: SOURCE.localId,
    occurrenceId: CONTRIBUTOR_GENERATION,
    sourceCustody: { kind: 'development' as const, registeredRootId: 'example-source-root' },
});

/**
 * A second admitted source at the same point, sorted ahead of the one that owns
 * the entry.
 *
 * It is what makes "the right contributor" a falsifiable claim: with one
 * contribution in the snapshot, mounting the first one and mounting the exact
 * one are the same code. Its own detail body says so, so a lookup that took the
 * first admitted contributor would render a tracker's view of a forge's pull
 * request — the exact wrong-provider mount the aggregate must not make.
 */
const OTHER_SOURCE = Object.freeze({
    pluginId: 'happier.example.another-source',
    localId: 'example-tracker',
});
const OTHER_CONTRIBUTOR = Object.freeze({
    pluginId: OTHER_SOURCE.pluginId,
    contributionId: OTHER_SOURCE.localId,
    occurrenceId: 'other-generation-a',
    sourceCustody: { kind: 'development' as const, registeredRootId: 'other-source-root' },
});
const OTHER_DETAIL_BODY_TEXT = 'The other source detail body';
const OTHER_DETAIL_SURFACE = Object.freeze({
    point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
    contributor: OTHER_CONTRIBUTOR,
    role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    presentation: 'content' as const,
});
const OTHER_CONTRIBUTOR_MANIFEST = definePlugin({
    id: OTHER_SOURCE.pluginId,
    version: '1.0.0',
    ui: {
        renderers: [{
            id: DETAIL_RENDERER_ID,
            kind: 'declarative',
            root: { kind: 'text', text: OTHER_DETAIL_BODY_TEXT },
        }],
    },
}).manifest;

const DETAIL_SURFACE = Object.freeze({
    point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
    contributor: CONTRIBUTOR,
    role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    presentation: 'content' as const,
});

/**
 * The complete final declarative projection carried by a current daemon mount.
 *
 * This fixture used to provide only `{ visible: true }` because the mount wire
 * treated `model` as an opaque record. The wire now composes the strict
 * Protocol-owned projected-model schema, so retaining that partial predecessor
 * makes the host refuse the whole mount before Triage's input is considered.
 * Keep this at the real boundary rather than omitting `model`: current producers
 * publish this shape and the mounted vertical is meant to exercise it.
 */
function projectedDetailModel(input: Readonly<{
    pluginId: string;
    generation: string;
    text: string;
}>) {
    return Object.freeze({
        identity: Object.freeze({
            pluginId: input.pluginId,
            localId: DETAIL_RENDERER_ID,
            qualifiedId: `${input.pluginId}/${DETAIL_RENDERER_ID}`,
            occurrenceId: input.generation,
        }),
        visible: true,
        requiredHostMethods: Object.freeze([]),
        declarativeInventory: Object.freeze({
            actions: Object.freeze([]),
            destinations: Object.freeze([]),
            settings: Object.freeze([]),
            uiQueries: Object.freeze([]),
        }),
        root: Object.freeze({
            kind: 'text' as const,
            path: 'root',
            order: 0,
            text: input.text,
        }),
    });
}

/**
 * The exact cold admission the physical host would hold. Its `inputSchema` is
 * the PUBLISHED detail role schema, so a launch input the contract would reject
 * renders the fallback instead of the child — which is what makes this a proof
 * of the strict boundary rather than of a prop being passed along.
 */
const ADMITTED_MOUNT = Object.freeze({
    kind: 'targetedSurface',
    target: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, occurrenceId: TARGET_GENERATION,
        sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' } },
    point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
    contributor: CONTRIBUTOR,
    role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    presentation: 'content',
    inputSchema: TriageDetailSurfaceInputV1JsonSchema,
    rendererChain: [{ pluginId: SOURCE.pluginId, localId: DETAIL_RENDERER_ID }],
    selectedRenderer: {
        identity: { pluginId: SOURCE.pluginId, localId: DETAIL_RENDERER_ID },
        renderer: {
            kind: 'declarative',
            contributionId: DETAIL_RENDERER_ID,
            model: projectedDetailModel({
                pluginId: SOURCE.pluginId,
                generation: CONTRIBUTOR_GENERATION,
                text: DETAIL_BODY_TEXT,
            }),
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    },
    executionOrigin: {
        serverIdentityId: 'srv_example',
        materializationRef: {
            machineId: 'machine-example',
            materializationId: `materialization-${CONTRIBUTOR_GENERATION}`,
            pluginId: SOURCE.pluginId,
        },
    },
    resourceCapability: { readable: true, dynamic: true },
    contributorTargetedContributions: {
        target: { pluginId: SOURCE.pluginId, occurrenceId: CONTRIBUTOR.occurrenceId, sourceCustody: CONTRIBUTOR.sourceCustody },
        points: [],
    },
});

const OTHER_ADMITTED_MOUNT = Object.freeze({
    ...ADMITTED_MOUNT,
    contributor: OTHER_CONTRIBUTOR,
    rendererChain: [{ pluginId: OTHER_SOURCE.pluginId, localId: DETAIL_RENDERER_ID }],
    selectedRenderer: {
        identity: { pluginId: OTHER_SOURCE.pluginId, localId: DETAIL_RENDERER_ID },
        renderer: {
            kind: 'declarative',
            contributionId: DETAIL_RENDERER_ID,
            model: projectedDetailModel({
                pluginId: OTHER_SOURCE.pluginId,
                generation: OTHER_CONTRIBUTOR.occurrenceId,
                text: OTHER_DETAIL_BODY_TEXT,
            }),
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    },
    executionOrigin: {
        serverIdentityId: 'srv_other',
        materializationRef: {
            machineId: 'machine-other',
            materializationId: 'materialization-other',
            pluginId: OTHER_SOURCE.pluginId,
        },
    },
    contributorTargetedContributions: {
        target: { pluginId: OTHER_SOURCE.pluginId, occurrenceId: OTHER_CONTRIBUTOR.occurrenceId, sourceCustody: OTHER_CONTRIBUTOR.sourceCustody },
        points: [],
    },
});

function surfaceContext(options: Readonly<{ contributesDetail?: boolean; tabbedDetail?: boolean; sourceSessionTab?: boolean; securityAlert?: boolean;
    fixPullRequestState?: 'unprojected' | 'unreachable'; taskEdit?: boolean }> = {}) {
    const contributesDetail = options.contributesDetail !== false;
    return createSurfaceContextFixture({
        mount: {
            kind: 'destination',
            destination: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: options.taskEdit ? 'tasks' : 'triage' },
            container: 'appPage',
        },
        targetedContributions: {
            target: {
                pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
                occurrenceId: TARGET_GENERATION,
                sourceCustody: { kind: 'development', registeredRootId: 'triage-root' },
            },
            points: [{
                pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
                protocols: [{
                    protocol: PROTOCOL,
                    contributions: [{
                        // Sorted first, exactly as the admitted snapshot orders
                        // contributors, and deliberately not the entry's source.
                        contributor: OTHER_CONTRIBUTOR,
                        protocol: PROTOCOL,
                        descriptor: {
                            ...DESCRIPTOR,
                            displayName: 'Another source',
                        },
                        operations: [],
                        surfaces: [OTHER_DETAIL_SURFACE],
                    }, {
                        contributor: CONTRIBUTOR,
                        protocol: PROTOCOL,
                        descriptor: options.securityAlert ? {
                            ...DESCRIPTOR, kinds: [{ id: 'dependabot-alert', workflowSubject: 'errorIssue', displayName: 'Dependabot alert', pluralDisplayName: 'Dependabot alerts',
                                detailActions: true, detailTabs: [{ kind: 'shared', id: 'overview' }] }],
                        } : options.taskEdit ? { ...TASK_DESCRIPTOR, kinds: TASK_DESCRIPTOR.kinds.map(kind => ({ ...kind,
                            ...(options.tabbedDetail ? { detailTabs: [{ kind: 'shared', id: 'overview' }] } : {}),
                        })) } : options.sourceSessionTab ? (() => {
                            const admitted = admitTriageSourceDescriptorV1({ ...DESCRIPTOR, kinds: [{ ...DESCRIPTOR.kinds[0], detailTabs: [
                                { kind: 'shared', id: 'overview' }, { kind: 'shared', id: 'files' },
                                { kind: 'source', id: 'session', title: 'Session history' },
                            ] }] });
                            if (!admitted.ok) throw new Error(`Public descriptor refused: ${admitted.reason}`);
                            return PluginJsonValueV2Schema.parse(admitted.descriptor);
                        })() : options.fixPullRequestState !== undefined ? {
                            ...DESCRIPTOR, kinds: [{ ...DESCRIPTOR.kinds[0], workflowSubject: 'issue', detailTabs: [
                                { kind: 'shared', id: 'overview' }, { kind: 'shared', id: 'activity' },
                            ] }, { id: 'fix-pr', workflowSubject: 'pullRequest', displayName: 'Pull request',
                                pluralDisplayName: 'Pull requests', detailTabs: [
                                    { kind: 'shared', id: 'files' }, { kind: 'shared', id: 'checks' },
                                ] }],
                        } : options.tabbedDetail ? {
                            ...DESCRIPTOR, kinds: DESCRIPTOR.kinds.map((kind) => ({ ...kind, detailTabs: [
                                { kind: 'shared', id: 'overview' }, { kind: 'shared', id: 'activity' },
                                { kind: 'shared', id: 'files' }, { kind: 'shared', id: 'checks' },
                            ] })),
                        } : DESCRIPTOR,
                        operations: options.taskEdit ? ['get', 'edit'].map(role => ({
                            point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
                            contributor: CONTRIBUTOR, role, action: { pluginId: SOURCE.pluginId, localId: role },
                        })) : [],
                        surfaces: contributesDetail ? [DETAIL_SURFACE] : [],
                    }],
                }],
            }],
        },
    });
}

function configuredInstance(
    sourceInstanceId: string = INSTANCE,
): TriageConfiguredSourceInstanceV1 {
    const second = sourceInstanceId === SECOND_INSTANCE;
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: SOURCE, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: {
                service: { pluginId: SOURCE.pluginId, localId: 'accounts' },
                accountId: second ? 'account-2' : 'account-1',
            },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
        // Deliberately not the entry's scope label: the header renders both,
        // and a fixture where they read the same would let one stand in for the
        // other.
        locator: { v: 1, displayLabel: second ? 'Second account' : 'Example account' },
    });
}

function configuredOtherSourceInstance(): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: OTHER_SOURCE, sourceInstanceId: OTHER_INSTANCE },
        binding: {
            purpose: 'triage-source',
            account: {
                service: { pluginId: OTHER_SOURCE.pluginId, localId: 'accounts' },
                accountId: 'account-other',
            },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'other-routing-token' },
        locator: { v: 1, displayLabel: 'Other source account' },
    });
}

function instanceRow(sourceInstanceId: string = INSTANCE): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `${sourceInstanceId === SECOND_INSTANCE ? 'b' : 'a'}${'0'.repeat(42)}`,
        sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: configuredInstance(sourceInstanceId),
    };
}

function otherSourceInstanceRow(): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `c${'0'.repeat(42)}`,
        sourceQualifiedId: `${OTHER_SOURCE.pluginId}/${OTHER_SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: configuredOtherSourceInstance(),
    };
}

function PostMutationProbe(): React.ReactElement {
    const complete = useTriagePostMutationCompletion();
    return (
        <Button
            title="Complete source mutation"
            onPress={() => {
                currentHarness?.mutateSourceEntry();
                void complete();
            }}
        />
    );
}

function createHarness(options: Readonly<{
    securityAlert?: boolean;
    nativeRoutingToken?: string;
    secondInstance?: boolean;
    secondInstanceObservesEntry?: boolean;
    otherSourceEntry?: boolean;
    deferLinkedEntry?: boolean;
    taskEdit?: boolean;
    uninstalledSource?: boolean;
    noActiveSource?: boolean;
    absentEntryIds?: readonly string[];
    exactReadFailure?: TriageSourceFailureV1;
    partialScan?: boolean;
    revokedEntryIds?: readonly string[];
}> = {}) {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue({ ...instanceRow(),
        ...(options.noActiveSource ? { lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired, retiredReason: 'userRemoved' as const } : {}),
    }));
    if (options.secondInstance === true) {
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow(SECOND_INSTANCE)));
    }
    if (options.otherSourceEntry === true || options.uninstalledSource === true) {
        control.sourceInstances.seed(toCorpusStoredValue(otherSourceInstanceRow()));
    }
    /** Every connection the mounted detail actually ran a read under. */
    const readDetailInstanceIds: string[] = [];
    const exactReads: Array<ReturnType<typeof TriageReobserveEntryInputV1Schema.parse>> = [];
    const getEntryIds: string[] = [];
    const continuedScanPages: string[] = [];
    /** Flipped to make the next pass observe nothing, so the row leaves. */
    const observes = { current: true };
    const deferLinkedEntry = { current: options.deferLinkedEntry === true };
    /** Makes one same-entry pass publish a genuinely newer observation. */
    const observationRevision = { current: 3_000 };
    let blockedDetailRead: Readonly<{
        promise: Promise<void>;
        release: () => void;
        entryId?: string;
    }> | null = null;
    let blockedReobservation: Readonly<{
        promise: Promise<void>;
        release: () => void;
        entryId?: string;
    }> | null = null;
    let failNextLinkedSessionPage = false;
    let detailReadsUnavailable = false;
    let sourceEntryMutated = false;
    let repeatNextLinkedSessionCursor = false;
    let finalLinkedSessionId: string | null = null;

    const admitted = [{
        contributor: CONTRIBUTOR,
        protocol: PROTOCOL,
        descriptor: options.securityAlert ? { ...DESCRIPTOR, kinds: [{ id: 'dependabot-alert', workflowSubject: 'errorIssue', displayName: 'Dependabot alert', pluralDisplayName: 'Dependabot alerts' }] } : options.taskEdit ? TASK_DESCRIPTOR : DESCRIPTOR,
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1, ...(options.otherSourceEntry === true ? [{
        contributor: OTHER_CONTRIBUTOR,
        protocol: PROTOCOL,
        descriptor: { ...DESCRIPTOR, displayName: 'Another source' },
        operations: { listInstances: {}, scan: { source: 'other' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1] : [])];

    const executeScan: TriageAdmittedOperationExecutorV1 = async (operation, input) => {
        if (input.page.kind !== 'initial') continuedScanPages.push(input.page.kind);
        if (deferLinkedEntry.current && input.page.kind === 'initial') {
            return {
                kind: 'page',
                observations: Array.from({ length: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 }, (_, index) => ({
                    kind: 'present' as const,
                    localRef: { kindId: options.securityAlert ? 'dependabot-alert' : 'pull-request',
                        collisionScope: 'example/repository', entryId: `preceding-${index}` },
                    locator: testkitLocator(),
                    snapshot: testkitSnapshot({ title: `Earlier change ${index}` }),
                    viewer: testkitViewer(),
                    sourceUpdatedAtMs: observationRevision.current + 1,
                })),
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: 'linked-entry' },
            } satisfies TriageScanResultV1;
        }
        return {
        kind: 'complete',
        observations: observes.current
            && (options.secondInstanceObservesEntry !== false
                || input.instance.instance.sourceInstanceId !== SECOND_INSTANCE) ? [{
            kind: 'present',
            localRef: { kindId: options.securityAlert ? 'dependabot-alert' : 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            locator: testkitLocator(options.nativeRoutingToken === undefined ? {} : { routingToken: options.nativeRoutingToken }),
            snapshot: testkitSnapshot({
                title: Reflect.get(operation as object, 'source') === 'other'
                    ? 'Another source matching entry'
                    : 'Replace the duplicated normalizer',
            }),
            viewer: testkitViewer({ involvement: options.taskEdit ? ['assignee'] : [] }),
            sourceUpdatedAtMs: observationRevision.current,
        }, {
            kind: 'present',
            localRef: {
                kindId: options.securityAlert ? 'dependabot-alert' : 'pull-request',
                collisionScope: LONG_SCOPE,
                entryId: LONG_ENTRY_ID,
            },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({
                title: LONG_REF_ROW_TITLE,
                // The one field long enough to hold the padding a near-full
                // page location needs while still MATCHING this row, now that
                // the query the location carries actually reaches the window.
                summary: SUMMARY_PADDING,
            }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 2_000,
        }] : [],
        evidence: options.uninstalledSource === true || options.partialScan === true
            ? { kind: 'partial', reason: 'projection-budget' } : { kind: 'walkFinished' },
        } satisfies TriageScanResultV1;
    };

    async function executeAction(request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> {
        const action = String(request.action);
        if (action === TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1) {
            return await setTriageEntryPinned(TriageSetEntryPinnedInputV1Schema.parse(request.input), {
                collections, nowMs: () => 2_000,
            });
        }
        if (action === 'sessions/read-source-links-v1') {
            return await readTestkitSourceSessionLinks(request.input, { collections, contributions: admitted });
        }
        if (action === 'sessions/unlink-entry-v1') {
            const input = TriageUnlinkEntryFromSessionActionInputV1Schema.parse(request.input);
            const unlinked = await unlinkEntryFromSession({
                ...input, sessionId: SessionIdSchema.parse(input.sessionId), collections,
            });
            return TriageUnlinkEntryFromSessionActionResultV1Schema.parse({ v: 1, status: unlinked.status });
        }
        if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
            // The real handler over the real Collections; only the invocation
            // context's caller stamp is the host's to supply.
            const detailInput = TriageReadEntryDetailInputV1Schema.parse(request.input);
            // Selection re-observation can replace an in-flight detail read. An
            // Account outage affects that replacement too, until the test restores it.
            if (detailInput.linkedSessionsCursor === undefined && detailReadsUnavailable) {
                throw new PluginError({ code: 'unavailable', retryable: true });
            }
            if (detailInput.linkedSessionsCursor !== undefined && failNextLinkedSessionPage) {
                failNextLinkedSessionPage = false;
                throw new Error('linked Session page unavailable');
            }
            readDetailInstanceIds.push(detailInput.sourceInstanceId);
            const blocked = blockedDetailRead;
            if (blocked !== null
                && (blocked.entryId === undefined || blocked.entryId === detailInput.entryRef.entryId)) {
                await blocked.promise;
            }
            const result = await readTriageEntryDetail(
                detailInput,
                {
                    sourceRelations: createTestkitSourceSessionRelations({ collections, contributions: admitted }),
                    readSessionSummary: async (sessionId) => ({
                        title: sessionId === finalLinkedSessionId
                            ? 'Linked Session 201'
                            : `Linked ${sessionId}`,
                    }),
                },
            );
            if (detailInput.linkedSessionsCursor !== undefined && repeatNextLinkedSessionCursor) {
                repeatNextLinkedSessionCursor = false;
                return result.kind === 'read'
                    ? { ...result, linkedSessionsNextCursor: detailInput.linkedSessionsCursor }
                    : result;
            }
            return result;
        }
        if (action === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
            const input = TriageReobserveEntryInputV1Schema.parse(request.input);
            exactReads.push(input);
            // A selection now performs an authoritative get before any mutation.
            // Capture provider state when the request starts, including for late replies.
            const mutated = sourceEntryMutated;
            const blocked = blockedReobservation;
            if (blocked !== null
                && (blocked.entryId === undefined || blocked.entryId === input.entryRef.entryId)) {
                blockedReobservation = null;
                await blocked.promise;
            }
            const isLongEntry = input.entryRef.entryId === LONG_ENTRY_ID;
            const isOtherSource = input.entryRef.source.pluginId === OTHER_SOURCE.pluginId;
            const result = await reobserveTriageEntry(input, {
                readConfiguredInstance: async (id, cancellation) => {
                    const row = await findConfiguredSourceInstanceRow(collections.sourceInstances, id, cancellation);
                    return row?.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active ? row.value.configured : null;
                },
                readAdmittedSources: async () => admitted,
                nowMs: () => observationRevision.current,
                // The fixture source is the external provider boundary; admission and qualification stay real.
                executeGet: async (_operation, request) => {
                    getEntryIds.push(request.localRef.entryId);
                    if (options.exactReadFailure !== undefined) {
                        return { kind: 'unresolved', localRef: request.localRef, failure: options.exactReadFailure };
                    }
                    if (options.revokedEntryIds?.includes(request.localRef.entryId)) {
                        return { kind: 'unresolved', localRef: request.localRef, failure: { class: 'permission', code: 'task_not_found' } };
                    }
                    if (options.absentEntryIds?.includes(request.localRef.entryId)) {
                        return { kind: 'absent', localRef: request.localRef };
                    }
                    return {
                        kind: 'present',
                        localRef: request.localRef,
                        locator: testkitLocator(options.nativeRoutingToken === undefined ? {} : { routingToken: options.nativeRoutingToken }),
                        snapshot: testkitSnapshot({
                            ...(options.taskEdit ? { projectionTruncated: true } : {}),
                            title: isLongEntry
                                ? LONG_REF_ROW_TITLE
                                : isOtherSource
                                    ? 'Another source matching entry'
                                    : mutated
                                        ? 'Replace the duplicated normalizer after mutation'
                                        : 'Replace the duplicated normalizer',
                        }),
                        viewer: testkitViewer({ involvement: options.taskEdit ? ['assignee'] : [] }),
                        sourceUpdatedAtMs: observationRevision.current,
                    };
                },
            });
            if (result.kind !== 'observed') return result;
            const { entryRef, ...observation } = result.observation;
            return { kind: 'observed', entryRef, observation: toTriageWireObservation(observation) };
        }
        return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => admitted,
            executeScan,
            nowMs: () => Date.now(),
        });
    }

    return {
        collections,
        executeAction,
        observes,
        deferLinkedEntry,
        readDetailInstanceIds,
        exactReads,
        getEntryIds,
        continuedScanPages,
        async seedPins(ids: readonly string[]) {
            for (const entryId of ids) await setTriageEntryPinned({ v: 1, pinned: true,
                entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId },
                displayAtMark: { title: `Pinned change ${entryId}`, scopeLabel: 'example/repository' },
            }, { collections, nowMs: () => 2_000 });
        },
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        readSessionTitle(sessionId: string): string {
            return sessionId === finalLinkedSessionId ? 'Linked Session 201' : `Linked ${sessionId}`;
        },
        async seedLinkedSessions(count: number): Promise<void> {
            const entryRef = TriageEntryRefV1Schema.parse({
                source: SOURCE,
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '17',
            });
            const entryTag = await deriveSessionLinkEntryTag(collections.sessionLinks, entryRef);
            const links = await Promise.all(Array.from({ length: count }, async (_unused, index) => {
                const sessionId = `session-linked-${String(index + 1).padStart(3, '0')}`;
                const linkTag = await deriveSessionLinkTag(collections.sessionLinks, entryRef, sessionId);
                return {
                    linkTag,
                    entryTag,
                    sessionId,
                    linkedAtMs: 4_000 + index,
                    entryRef,
                    identityEntryRef: entryRef,
                    displayPathAtLink: 'example/repository#17',
                } satisfies CorpusSessionLinkRowV1;
            }));
            for (const link of links) control.sessionLinks.seed(toCorpusStoredValue(link));
            const first = await collections.sessionLinks.query({
                index: 'by-entry',
                prefix: [entryTag],
                order: 'asc',
                limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
            });
            if (first.nextCursor === undefined) return;
            const second = await collections.sessionLinks.query({
                index: 'by-entry',
                prefix: [entryTag],
                order: 'asc',
                cursor: first.nextCursor,
                limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
            });
            const finalRow = second.rows[0];
            if (finalRow === undefined) throw new Error('Expected the final linked Session row.');
            finalLinkedSessionId = fromCorpusStoredRow<CorpusSessionLinkRowV1>(finalRow).value.sessionId;
        },
        failNextLinkedSessionPage(): void {
            failNextLinkedSessionPage = true;
        },
        setDetailReadsUnavailable(unavailable: boolean): void {
            detailReadsUnavailable = unavailable;
        },
        mutateSourceEntry(): void {
            sourceEntryMutated = true;
        },
        restoreSourceEntry(): void {
            sourceEntryMutated = false;
        },
        repeatNextLinkedSessionCursor(): void {
            repeatNextLinkedSessionCursor = true;
        },
        publishNewerObservation(): void {
            observationRevision.current += 1;
        },

        blockNextDetailRead(entryId?: string): () => void {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => { release = resolve; });
            blockedDetailRead = { promise, release, ...(entryId === undefined ? {} : { entryId }) };
            const blocked = blockedDetailRead;
            return () => {
                if (blockedDetailRead === blocked) blockedDetailRead = null;
                release();
            };
        },
        blockNextReobservation(entryId?: string): () => void {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => { release = resolve; });
            blockedReobservation = { promise, release, ...(entryId === undefined ? {} : { entryId }) };
            return release;
        },
    };
}

const mounted: PluginUiTestkit[] = [];
const securityAlertActivity = { active: true, activeSignal: new AbortController().signal };
const securityAlertRenderers = { renderMarkdown: () => null, renderOutcome: () => null };
const FIXTURE_PRIMARY_WRITE: TriageDetailPrimaryWriteV1 = {
    title: 'Fixture primary write', pending: false, disabledReason: null, execute: async () => {},
};
function PrimaryWriteProbe(): React.ReactElement {
    const host = useTriageEvidenceDisclosure().primaryWrite;
    const offer = host?.offer;
    React.useLayoutEffect(() => {
        offer?.(FIXTURE_PRIMARY_WRITE);
        return () => { offer?.(null); };
    }, [offer]);
    return <Text value={host?.value?.title ?? 'No primary write host'} />;
}
let currentHarness: ReturnType<typeof createHarness> | null = null;
/**
 * The last same-page replacement this mount asked the host for.
 *
 * The Back case below settles the page's OWN declared step rather than a
 * hand-written location, so it cannot pass against a shell that declares no
 * step, declares one that still names the selected entry, or spells the route
 * differently than it parses it.
 */
let lastPageLocation: Readonly<{ subPath: string; backLocation: string | undefined }> | null = null;

async function mountShell(
    options: Readonly<{
        contributesDetail?: boolean;
        subPath?: string;
        launchInput?: JsonValue;
        deliveredLaunch?: { current: JsonValue | undefined };
        explicitOpen?: boolean;
        deferSourceDescriptor?: boolean;
        absentEntryIds?: readonly string[];
        exactReadFailure?: TriageSourceFailureV1;
        partialScan?: boolean;
    revokedEntryIds?: readonly string[];
        secondInstance?: boolean;
        secondInstanceObservesEntry?: boolean;
        pinnedEntryIds?: readonly string[];
        noScannedEntries?: boolean;
        noActiveSource?: boolean;
        otherSourceEntry?: boolean;
        deferLinkedEntry?: boolean;
        linkedSessionCount?: number;
        sessionTitle?: string;
        hostedDetail?: boolean;
        offerPrimaryWrite?: boolean;
        tabbedDetail?: boolean;
        sourceOverviewProbe?: boolean;
        securityAlert?: boolean;
        onSecurityAlertWrite?: (request: PluginUiTestkitExecuteActionInput) => void;
        onOverviewRead?: () => void;
        sourceSessionTab?: boolean;
        activeSurface?: boolean;
        hostTarget?: { ready: boolean; pending?: boolean; executionReady?: boolean };
        automaticDemandOnly?: boolean;
        onAggregateRead?: () => void;
        refusedHostReads?: Set<string>;
        detailFailure?: PluginError;
        mountedActionFailure?: 'reject' | 'unavailable';
        onNotification?: (notification: Readonly<{ message: string; severity?: string }>) => void;
        onDiagnostic?: (data: Readonly<{ code: string }>) => void;
        fixPullRequestState?: 'unprojected' | 'unreachable';
        taskEdit?: boolean;
        uninstalledSource?: boolean;
        onTaskEdit?: (input: unknown) => void;
        onTaskDraft?: (input: unknown) => void;
        taskOrigin?: ReturnType<typeof TriageTaskOriginErrorV1Schema.parse>;
        publishCurrentUiContext?: (context: PluginUiContextEnrichmentV1 | null) => void;
        onPageNavigation?: (navigation: PluginUiPageNavigationV1 | null) => void;
        onPageLocationRequest?: (subPath: string) => void;
        replacePageLocation?: (request: Readonly<{
            subPath: string;
            backLocation: string | undefined;
            signal: AbortSignal;
        }>) => string | Promise<string>;
    }> = {},
): Promise<PluginUiTestkit> {
    const harness = createHarness({
        ...(options.securityAlert ? { securityAlert: true, nativeRoutingToken: 'example/repository' } : {}),
        ...(options.sourceOverviewProbe ? { nativeRoutingToken: 'example/repository' } : {}),
        ...(options.secondInstance === undefined ? {} : { secondInstance: options.secondInstance }),
        ...(options.secondInstanceObservesEntry === undefined
            ? {}
            : { secondInstanceObservesEntry: options.secondInstanceObservesEntry }),
        ...(options.otherSourceEntry === undefined ? {} : { otherSourceEntry: options.otherSourceEntry }),
        ...(options.deferLinkedEntry === undefined ? {} : { deferLinkedEntry: options.deferLinkedEntry }),
        ...(options.taskEdit === undefined ? {} : { taskEdit: options.taskEdit }),
        ...(options.uninstalledSource === undefined ? {} : { uninstalledSource: options.uninstalledSource }),
        ...(options.noActiveSource === undefined ? {} : { noActiveSource: options.noActiveSource }),
        ...(options.absentEntryIds === undefined ? {} : { absentEntryIds: options.absentEntryIds }),
        ...(options.exactReadFailure === undefined ? {} : { exactReadFailure: options.exactReadFailure }),
        ...(options.partialScan === undefined ? {} : { partialScan: options.partialScan }),
        ...(options.revokedEntryIds === undefined ? {} : { revokedEntryIds: options.revokedEntryIds }),
    });
    currentHarness = harness;
    let hostSubPath = options.subPath ?? '';
    if (options.pinnedEntryIds) await harness.seedPins(options.pinnedEntryIds);
    if (options.noScannedEntries) harness.observes.current = false;
    if (options.linkedSessionCount !== undefined) {
        await harness.seedLinkedSessions(options.linkedSessionCount);
    }
    lastPageLocation = null;
    let fixture!: PluginUiTestkit;
    let failFixRead = options.fixPullRequestState === 'unreachable';
    // The real host records the declaration before publishing its async context
    // projection. A press can arrive before that projection finishes rendering.
    let pageNavigation: PluginUiPageNavigationV1 | null = null;
    const projectPage = (request?: string) => ({ columnVisible: true,
        ...(pageNavigation === null ? {} : { navigation: {
            pageKind: pageNavigation.pageKind, items: pageNavigation.items,
            tabIds: pageNavigation.items.map(item => item.value), presentation: 'local' as const,
            ...(request === undefined ? {} : { request }),
        } }),
    });
    const admittedSurface = surfaceContext(options);
    // The host retains one delivered launch object until navigation retires it.
    const pageLaunch = options.explicitOpen ? { kind: 'explicit' as const } : undefined;
    const { targetedContributions: _targetedContributions, ...accountSurface } = admittedSurface;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-186', mountNonce: 'fixture-mount-186' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            ...(options.subPath === undefined ? {} : { subPath: options.subPath }),
            ...(options.launchInput === undefined ? {} : { launchInput: options.launchInput }),
            // The semantic host's RenderContext omits its activity snapshot;
            // supply this genuine host boundary fact for mounted-action cases.
            surface: (context) => (options.taskEdit ? renderTasksSurface : renderShellSurface)(
                { ...context,
                    ...(options.deliveredLaunch === undefined ? {} : { launchInput: options.deliveredLaunch.current }),
                    ...(pageLaunch === undefined ? {} : { launch: pageLaunch }),
                    activity: { active: options.activeSurface === true } }),
            surfaceContext: options.hostTarget?.ready === false
                ? { ...accountSurface, machineConnectionPending: options.hostTarget.pending ?? true,
                    ...(options.hostTarget.executionReady === undefined ? {} : { machineExecutionReady: options.hostTarget.executionReady }) }
                : options.deferSourceDescriptor ? { ...admittedSurface, targetedContributions: {
                    ...admittedSurface.targetedContributions!, points: [],
                } } : admittedSurface,
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                ephemeralSharedScope: harness.ephemeralSharedScope,
                sessions: true,
                overlays: true,
                ...(options.hostedDetail ? { detailsPane: { available: true } } : {}),
                targetedSurfaces: {
                    readCurrentMounts: () => [ADMITTED_MOUNT, OTHER_ADMITTED_MOUNT],
                    readContributorManifest: (pluginId: string) => (
                        pluginId === OTHER_SOURCE.pluginId
                            ? OTHER_CONTRIBUTOR_MANIFEST
                            : CONTRIBUTOR_MANIFEST
                    ),
                    renderAdmittedContent: ({ content, launchInput }) => options.securityAlert ? (
                        <TriageDetailInstance><GithubSecurityAlertBody input={TriageDetailSurfaceInputV1Schema.parse(launchInput)}
                            detailActivity={securityAlertActivity}
                            renderers={securityAlertRenderers} /></TriageDetailInstance>
                    ) : (
                        <>{content}<PostMutationProbe />{options.offerPrimaryWrite ? <PrimaryWriteProbe /> : null}
                          {options.sourceOverviewProbe ? <MountedOverviewProbe input={launchInput} /> : null}</>
                    ),
                },
            }),
            handlers: {
                setPageNavigation: async ({ navigation }) => {
                    pageNavigation = navigation;
                    options.onPageNavigation?.(navigation);
                    if (!fixture) return;
                    const current = await fixture.context.hostApi.context();
                    await fixture.updateSurface({ ...current, page: projectPage() });
                },
                readSession: ({ sessionId }) => ({
                    sessionId, title: options.sessionTitle ?? harness.readSessionTitle(sessionId),
                    lifecycle: 'active', runtime: 'waiting', operational: 'ready',
                    workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' }, pendingPermissions: [],
                }),
                notify: async (notification) => { options.onNotification?.(notification); },
                diagnostic: ({ data }) => { options.onDiagnostic?.(data); },
                publishCurrentUiContext: ({ enrichment }) => options.publishCurrentUiContext?.(enrichment),
                executeAction: async (request): Promise<JsonValue> => {
                    const { action, input } = request;
                    // The persisted relationship Action is the genuine host transport boundary.
                    if (action === TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1 && options.taskOrigin !== undefined) {
                        return { v: 1, originError: options.taskOrigin };
                    }
                    if (action === 'tasks/open-create-v1' && options.onTaskDraft !== undefined) {
                        options.onTaskDraft(input);
                        return { status: 'applied' };
                    }
                    if (options.sourceOverviewProbe && typeof action !== 'string' && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview) {
                        options.onOverviewRead?.();
                        // The host Action transport is the genuine boundary here;
                        // registered GitHub producer coverage lives in readDispatch.
                        return GithubOverviewResultV1Schema.parse({ kind: 'overview', kindId: 'pull-request',
                            observedAtMs: 3_000, body: 'Settled source body', branchUpdateEligibility: 'unknown' });
                    }
                    if (typeof action === 'object' && action !== null && action.pluginId === 'happier.scm.forge.github') {
                        if (action.localId === GITHUB_SECURITY_ALERT_ACTION_IDS_V1.read) return GithubSecurityAlertReadResultV1Schema.parse({
                            kind: 'alert', kindId: 'dependabot-alert', detail: {
                                nativeState: 'open', severity: 'high', projectionTruncated: false,
                                url: 'https://github.com/example/repository/security/dependabot/17',
                                dismissedReason: null, dismissedComment: null, dismissedBy: null, dismissedAt: null,
                                summary: 'Prototype pollution in lodash', advisory: '', advisoryId: 'GHSA-xxxx-yyyy-zzzz',
                                packageName: 'lodash', ecosystem: 'npm', manifestPath: 'package.json', dependencyScope: 'runtime',
                                relationship: 'direct', affectedRange: '< 4.17.21', patchedVersion: '4.17.21',
                            },
                            observation: { kind: 'present',
                                localRef: { kindId: 'dependabot-alert', collisionScope: 'example/repository', entryId: '17' },
                                locator: testkitLocator({ routingToken: 'example/repository' }),
                                snapshot: testkitSnapshot(), viewer: testkitViewer(),
                            },
                        });
                        options.onSecurityAlertWrite?.(request);
                        throw new Error('No GitHub writes in the mounted dismissal test');
                    }
                    if (action === 'shell.column.set' && typeof input === 'object' && input !== null && 'tab' in input && typeof input.tab === 'string') {
                        const current = await fixture.context.hostApi.context();
                        if (pageNavigation !== null) await fixture.updateSurface({ ...current, page: projectPage(input.tab) });
                        return { ok: true };
                    }
                    if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 && options.detailFailure !== undefined) {
                        throw options.detailFailure;
                    }
                    if (options.taskEdit && typeof action !== 'string' && action.localId === 'get') {
                        return { kind: 'present', localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                            locator: testkitLocator(), snapshot: testkitSnapshot({ projectionTruncated: true }), viewer: testkitViewer(),
                            taskFields: { title: 'Replace the duplicated normalizer', body: 'Complete source notes\n\nPreserve Markdown.  \n', dueDate: '2026-11-20' } };
                    }
                    if (options.taskEdit && action === 'tasks/edit-v1') {
                        options.onTaskEdit?.(input);
                        return { kind: 'applied', observation: {
                            kind: 'present', localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                            locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
                        } };
                    }
                    if (typeof action === 'string' && options.refusedHostReads?.has(action)) throw new PluginError({
                        code: 'unavailable', retryable: true,
                        diagnostics: [{ code: 'plugin_mounted_caller_unavailable', severity: 'error' }],
                    });
                    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
                        options.onAggregateRead?.();
                        if (options.hostTarget?.ready === false) throw new PluginError({
                            code: 'unavailable', retryable: true,
                            diagnostics: [{ code: 'plugin_mounted_caller_unavailable', severity: 'error' }],
                        });
                    }
                    if (action === 'ui/mounted-v1') {
                        if (options.mountedActionFailure === 'reject') throw new PluginError({
                            code: 'unavailable', diagnostics: [{ code: 'plugin_surface_client_action_unavailable', severity: 'error' }],
                        });
                        if (options.mountedActionFailure === 'unavailable') return { status: 'unavailable' };
                        const parsed = TriageMountedUiInputV1Schema.parse(input);
                        return await invokeTriageMountedUiAction(harness.ephemeralSharedScope, parsed.mountId,
                            parsed.operation, new AbortController().signal);
                    }
                    if (action === 'marks/read-fix-pull-requests-v1' && options.fixPullRequestState !== undefined) {
                        if (failFixRead) { failFixRead = false; throw new Error('Account transport unavailable'); }
                        const primary = { entryRef: { source: SOURCE, kindId: 'fix-pr', collisionScope: 'example/repository', entryId: '999' },
                            origins: ['user'], status: 'unknown', display: { title: 'Unprojected fix' } };
                        return { v: 1, candidates: [primary], primary, incomplete: false };
                    }
                    return await harness.executeAction(request);
                },
                replacePageLocation: async ({ subPath, backLocation, signal }) => {
                    options.onPageLocationRequest?.(subPath);
                    // The real host settles view/Back metadata at the same
                    // location without invoking its navigation adapter.
                    if (subPath === hostSubPath) return subPath;
                    hostSubPath = subPath;
                    lastPageLocation = { subPath, backLocation };
                    const settled = options.replacePageLocation === undefined
                        ? subPath
                        : await options.replacePageLocation({ subPath, backLocation, signal });
                    hostSubPath = settled;
                    return settled;
                },
            },
        });
    });
    mounted.push(fixture);
    if (!options.automaticDemandOnly) await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, harness.ephemeralSharedScope);
    });
    return fixture;
}

function clientActionUi(shell: PluginUiTestkit): PluginClientActionUi {
    const host = shell.context.hostApi;
    return {
        ...host,
        context: async (options) => {
            const context = await host.context(options);
            return { accountScope: context.accountScope, targetedContributions: context.targetedContributions ?? null };
        },
    };
}

async function refreshMountedShell(shell: PluginUiTestkit, context: PluginUiContextEnrichmentV1 | null): Promise<void> {
    const command = context?.commands?.find(entry => {
        if (entry.command.kind !== 'executeAction') return false;
        const parsed = TriageMountedUiInputV1Schema.safeParse(entry.command.input);
        return parsed.success && parsed.data.operation.kind === 'refresh';
    });
    if (command?.command.kind !== 'executeAction') throw new Error('Missing mounted Refresh command');
    await shell.context.hostApi.executeAction(command.command.action, command.command.input);
}

async function openTheRow(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('button', {
            name: 'Replace the duplicated normalizer',
        }));
    });
    // Let the detail read settle through the real Action seam.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
}

/**
 * The detail Session item's companion, mounted the way the host opens it: an App side view beside the
 * page, joining the same Account-shared window and Action seam, told only what the opening page holds.
 */
async function mountEntrySessionCompanion(openedFrom: Readonly<{ subPath: string | null }> | undefined,
    options: Readonly<{ ownScope?: boolean; paneHeader?: boolean }> = {}): Promise<PluginUiTestkit> {
    const harness = currentHarness;
    if (harness === null) throw new Error('Mount the shell first');
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-companion', mountNonce: 'fixture-mount-companion' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            // The side pane is an Account-backed plugin mount, as live: its configured sources come from the
            // Account Collection through the host-cloned surface entry's Data client.
            surface: renderContext => {
                const dataClient: PluginUiDataClient = {
                    collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition) {
                        const collection = definition.id === 'source-instances' ? harness.collections.sourceInstances
                            : definition.id === 'session-links' ? harness.collections.sessionLinks
                            : definition.id === 'user-marks' ? harness.collections.userMarks : null;
                        if (collection === null) throw new Error(`Undeclared test Collection: ${definition.id}`);
                        return collection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
                    },
                    accountKv: createTestkitAccountKv().kv,
                    openCollectionQuery: async () => { throw new Error('The companion opens no UI query'); },
                };
                const entry = renderEntrySessionCompanion(renderContext);
                return React.cloneElement(entry as unknown as React.ReactElement<{ dataClient?: PluginUiDataClient }>, { dataClient });
            },
            surfaceContext: createSurfaceContextFixture({
                mount: { kind: 'destination', destination: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'entry-linked-session' },
                    container: 'rightSidebarTab' },
                ...(openedFrom === undefined ? {} : { openedFrom: {
                    pageKind: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'entry' }, subPath: openedFrom.subPath,
                } }),
            }),
            // `ownScope`: the side pane's own mount, which shares nothing with the page (the live host case).
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: options.ownScope
                ? createTriageEphemeralSharedScopeFixture() : harness.ephemeralSharedScope, sessions: true, overlays: true,
                ...(options.paneHeader === true ? { paneHeader: true } : {}) }),
            handlers: {
                readSession: ({ sessionId }) => ({
                    sessionId, title: harness.readSessionTitle(sessionId),
                    lifecycle: 'active', runtime: 'waiting', operational: 'ready',
                    workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' }, pendingPermissions: [],
                }),
                executeAction: async (request): Promise<JsonValue> => await harness.executeAction(request),
            },
        });
    });
    mounted.push(fixture);
    return fixture;
}

function MountedOverviewProbe({ input }: Readonly<{ input: unknown }>) {
    const overview = useGithubOverview(TriageDetailSurfaceInputV1Schema.parse(input), { readWhenActive: true });
    return <Text testID="mounted-source-overview" value={overview.value?.body ?? 'Reading source body'} />;
}

it('re-enters the same settled entry through the real shell without another Overview read', async () => {
    let overviewReads = 0;
    const shell = await mountShell({ activeSurface: true, tabbedDetail: true, sourceOverviewProbe: true,
        onOverviewRead: () => { overviewReads += 1; } });
    await openTheRow(shell);
    await vi.waitFor(async () => { expect(await shell.getByText('Settled source body')).toBeDefined(); });
    expect(overviewReads).toBe(1);
    await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Back' })); });
    expect(await shell.queryByText('Settled source body')).toBeUndefined();
    await openTheRow(shell);
    await vi.waitFor(async () => { expect(await shell.getByText('Settled source body')).toBeDefined(); });
    expect(overviewReads).toBe(1);
    await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Back' })); });
    currentHarness!.publishNewerObservation();
    await openTheRow(shell);
    await vi.waitFor(() => { expect(overviewReads).toBe(2); });
    await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Back' })); });
    await openTheRow(shell);
    await vi.waitFor(async () => { expect(await shell.getByText('Settled source body')).toBeDefined(); });
    expect(overviewReads).toBe(2);
});

it.each(['current', 'uninstalled', 'aged'] as const)('edits the selected task despite truncated row facts and list freshness: %s', async (state) => {
    const edits: ReturnType<typeof TriageEditTaskActionInputV1Schema.parse>[] = [];
    const shell = await mountShell({ taskEdit: true, uninstalledSource: state === 'uninstalled',
        onTaskEdit: input => edits.push(TriageEditTaskActionInputV1Schema.parse(input)) });
    if (state === 'aged') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1);
        await act(async () => { await shell.updateSurface(surfaceContext({ taskEdit: true })); });
        expect(readTriageListWindowSnapshot(shell.context.hostApi, currentHarness!.ephemeralSharedScope).freshness).toBe('fresh');
    }
    if (state === 'uninstalled') {
        const snapshot = readTriageListWindowSnapshot(shell.context.hostApi, currentHarness!.ephemeralSharedScope);
        // The available lane completed a current read. An unavailable contributor
        // keeps its own health/coverage without aging that successful answer.
        expect(snapshot).toMatchObject({ pending: 'idle', freshness: 'fresh' });
        // TASK-NOSRC's catalog always includes the built-in Account task source beside these two external sources.
        expect(snapshot.configuredSources.map(source => source.sourceInstanceId).sort()).toEqual([
            INSTANCE, OTHER_INSTANCE, INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId,
        ].sort());
        expect(snapshot.window?.lanes).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceInstanceId: OTHER_INSTANCE, health: { kind: 'unavailable' } }),
        ]));
    }
    await openTheRow(shell);
    // A whole-body task opens its title-and-notes editor from its Notes chapter, in that chapter's place (lab t1).
    await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Edit title and notes' })); });
    const notes = document.querySelector<HTMLTextAreaElement>(`[data-testid="${TRIAGE_TASK_STORY_TEST_ID_V1}"] [data-testid="${TRIAGE_TASK_TEXT_EDITOR_TEST_ID_V1}"] textarea[aria-label="Notes"]`);
    expect(notes?.value).toBe('Complete source notes\n\nPreserve Markdown.  \n');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Updated source notes\n');
        notes!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Save changes' })); });
    expect(edits).toMatchObject([{ entryRef: { source: SOURCE, entryId: '17' }, sourceInstanceId: INSTANCE,
        fields: { body: 'Updated source notes\n' } }]);
    expect(edits[0]?.fields).not.toHaveProperty('title');
});

type LayoutHandler = (event: Readonly<{
    nativeEvent: Readonly<{ layout: Readonly<{ x: number; y: number; width: number; height: number }> }>;
}>) => void;

async function measureFillRegion(width: number): Promise<void> {
    const node = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}:stage"]`);
    if (node === null) throw new Error('The Triage shell rendered no measured fill region.');
    const handler = (node as unknown as Record<string, unknown>).__reactLayoutHandler;
    if (typeof handler !== 'function') throw new Error('The Triage shell installed no layout observer.');
    await act(async () => {
        (handler as LayoutHandler)({
            nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } },
        });
    });
}

function queryDetailBodyNode(): Element | null {
    return Array.from(document.querySelectorAll('*')).find(
        (candidate) => candidate.children.length === 0 && candidate.textContent === DETAIL_BODY_TEXT,
    ) ?? null;
}

/** Controls belong to the selected detail, not the Collection's own pager. */
function queryDetailButton(name: string): HTMLElement | undefined {
    const region = document.querySelector(`[data-testid="${TRIAGE_SHELL_DETAIL_REGION_TEST_ID_V1}"]`);
    if (region === null) throw new Error('The selected detail region is not mounted.');
    return Array.from(region.querySelectorAll<HTMLElement>('[role="button"], button')).find(
        (button) => (button.getAttribute('aria-label') ?? button.textContent) === name,
    );
}

function pressDetailButton(name: string): void {
    const button = queryDetailButton(name);
    if (button === undefined) throw new Error(`The detail has no ${name} button.`);
    button.click();
}

function detailBodyNode(): Element {
    const node = queryDetailBodyNode();
    if (node === null) throw new Error('The admitted source detail body is not mounted.');
    return node;
}

function focusButton(name: string): void {
    const button = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
        (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent === name,
    );
    if (button === undefined) throw new Error(`The ${name} button is not mounted.`);
    button.focus();
}

function activeElementName(): string | null {
    return document.activeElement?.getAttribute('aria-label')
        ?? document.activeElement?.textContent
        ?? null;
}

afterEach(async () => {
    currentHarness = null;
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/** The fixture entry's "Opened …" phrase, in the same relative words the header computes from its clock. */
function openedFixtureEntry(): string {
    return `Opened ${formatTriageTimestampV1('en', testkitSnapshot().createdAtMs ?? 0, 'relative', Date.now())}`;
}

describe('opening a row into the source detail', () => {
    it.each(['click', 'Enter', 'Peek', 'agent'] as const)('opens an unsynchronized pin through one exact read: %s', async (gesture) => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const shell = await mountShell({ pinnedEntryIds: ['657'], noScannedEntries: true, secondInstance: true,
            activeSurface: true, publishCurrentUiContext: context => { published = context; } });
        await measureFillRegion(1440);
        const harness = currentHarness!;
        const pin = await shell.getByRole('button', { name: 'Pinned change 657' });
        expect(harness.exactReads).toHaveLength(0);
        if (gesture === 'Peek' || gesture === 'agent') {
            // Use the public Collection's row disclosure, then its existing Open action.
            const command = (published as PluginUiContextEnrichmentV1 | null)?.commands?.find(entry => entry.title === 'Switch to Board');
            if (command?.command.kind !== 'executeAction') throw new Error('Expected the mounted Action');
            const address = TriageMountedUiInputV1Schema.parse(command.command.input);
            await act(async () => { expect(await invokeTriageMountedUiAction(harness.ephemeralSharedScope,
                address.mountId, { kind: gesture === 'Peek' ? 'peekRow' : 'openDetail', entryRef: { source: SOURCE, kindId: 'pull-request',
                    collisionScope: 'example/repository', entryId: '657' } }, new AbortController().signal))
                .toEqual({ status: 'applied' }); });
            if (gesture === 'Peek') {
                const open = await shell.queryByRole('button', { name: 'Open' });
                expect(open, 'An unsynchronized pin must expose the ordinary Peek Open action').toBeDefined();
                await act(async () => { await shell.press(open!); });
            }
        } else if (gesture === 'Enter') {
            const row = document.querySelector<HTMLElement>('[aria-label="Pinned change 657"]');
            expect(row).not.toBeNull();
            await act(async () => { row!.focus(); });
            await act(async () => {
                row!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                row!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
                // jsdom does not synthesize the native button's browser-default keyboard click.
                if (row!.tagName === 'BUTTON') row!.click();
            });
        } else {
            await act(async () => { await shell.press(pin); });
        }
        await vi.waitFor(() => { expect(harness.exactReads).toHaveLength(1); });
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        expect(harness.exactReads).toEqual([{ v: 1, entryRef: { source: SOURCE, kindId: 'pull-request',
            collisionScope: 'example/repository', entryId: '657' }, sourceInstanceId: INSTANCE }]);
        expect(harness.readDetailInstanceIds).toEqual([INSTANCE]);
        expect(harness.getEntryIds).toEqual(['657']);
    });

    it('keeps an unsynchronized pin open when the host publishes its location before acknowledging the write', async () => {
        const routes: string[] = [];
        let acknowledge!: (subPath: string) => void;
        const routeWritten = new Promise<string>(resolve => {
            acknowledge = resolve;
        });
        const shell = await mountShell({ pinnedEntryIds: ['657'], noScannedEntries: true,
            replacePageLocation: ({ subPath }) => { routes.push(subPath); return routeWritten; } });
        const harness = currentHarness!;
        const releaseRead = harness.blockNextReobservation('657');
        try {
            await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Pinned change 657' })); });
            await vi.waitFor(() => { expect(harness.exactReads).toHaveLength(1); expect(routes).toHaveLength(1); });
            const openedPath = routes[0]!;
            // Host location publication and the async write result are independent deliveries.
            await act(async () => { await shell.updatePageLocation(openedPath); });
            await act(async () => { acknowledge(openedPath); releaseRead(); });
            await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
            expect(routes).toEqual([openedPath]);
            expect(harness.exactReads).toHaveLength(1);
            expect(harness.getEntryIds).toEqual(['657']);

            // A genuine host Back still retires the detail rather than retaining the pin.
            await act(async () => { await shell.updatePageLocation(''); });
            await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
            expect(harness.exactReads).toHaveLength(1);
        } finally { acknowledge(routes[0] ?? ''); releaseRead(); }
    });

    it('renders many unsynchronized pins without exact per-row reads', async () => {
        const ids = Array.from({ length: 30 }, (_, index) => String(600 + index));
        const shell = await mountShell({ pinnedEntryIds: ids, noScannedEntries: true });
        await expect(shell.getByRole('button', { name: 'Pinned change 600' })).resolves.toBeDefined();
        await act(async () => { await shell.updateSurface(surfaceContext()); });
        expect(currentHarness!.exactReads).toEqual([]);
        expect(currentHarness!.getEntryIds).toEqual([]);
        expect(currentHarness!.readDetailInstanceIds).toEqual([]);
    });

    it('retires a pending unsynchronized pin open when another pin is opened', async () => {
        const shell = await mountShell({ pinnedEntryIds: ['657', '658'], noScannedEntries: true });
        await measureFillRegion(1440);
        const harness = currentHarness!;
        const releaseFirst = harness.blockNextReobservation('657');
        try {
            await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Pinned change 657' })); });
            await vi.waitFor(() => { expect(harness.exactReads).toHaveLength(1); });
            expect(harness.readDetailInstanceIds).toEqual([]);
            await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Pinned change 658' })); });
            await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
            expect(harness.exactReads.map(read => read.entryRef.entryId)).toEqual(['657', '658']);
            await act(async () => { releaseFirst(); });
            await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
            expect(harness.readDetailInstanceIds).toEqual([INSTANCE]);
            expect(harness.exactReads).toHaveLength(2);
        } finally { releaseFirst(); }
    });

    it('titles a refused unsynchronized pin with its pinned title, not the failure', async () => {
        // Live READY142: the hosted header said "These details could not be read" above the same failure body.
        const shell = await mountShell({ pinnedEntryIds: ['657'], noScannedEntries: true, hostedDetail: true,
            refusedHostReads: new Set([TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1]) });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Pinned change 657' })); });
        await vi.waitFor(() => { expect(document.body.textContent).toContain('These details could not be read'); });
        await expect(shell.getByRole('heading', { name: 'Pinned change 657' })).resolves.toBeDefined();
        await expect(shell.queryByRole('heading', { name: 'These details could not be read' })).resolves.toBeUndefined();
    });

    it('explains unavailable source admission without reading an unsynchronized pin', async () => {
        const shell = await mountShell({ pinnedEntryIds: ['657'], noScannedEntries: true, noActiveSource: true });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Pinned change 657' })); });
        await expect(shell.getByText('No connection to open this through')).resolves.toBeDefined();
        expect(currentHarness!.exactReads).toEqual([]);
        expect(currentHarness!.readDetailInstanceIds).toEqual([]);
    });

    it('keeps the opened pin detail authoritative after unpinning it', async () => {
        const shell = await mountShell({ pinnedEntryIds: ['657'], noScannedEntries: true });
        const harness = currentHarness!;
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Pinned change 657' })); });
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Unpin Replace the duplicated normalizer' })); });
        await vi.waitFor(async () => {
            await expect(shell.getByRole('button', { name: 'Pin Replace the duplicated normalizer' })).resolves.toBeDefined();
        });
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        harness.mutateSourceEntry();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Complete source mutation' })); });
        await expect(shell.getByRole('heading', { name: 'Replace the duplicated normalizer after mutation' })).resolves.toBeDefined();
        expect(harness.exactReads).toHaveLength(2);
    });

    it('makes an error task draft with the real detail title and complete error origin', async () => {
        const drafts: unknown[] = [];
        const entryRef = { source: SOURCE, kindId: 'dependabot-alert', collisionScope: 'example/repository', entryId: '17' };
        const shell = await mountShell({ activeSurface: true, securityAlert: true,
            onTaskDraft: draft => drafts.push(draft),
            subPath: buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: entryRef }),
        });
        await act(async () => { await shell.press(await vi.waitFor(() => shell.getByRole('button', { name: 'More actions' }))); });
        await act(async () => { await shell.press(await vi.waitFor(() => shell.getByRole('menuitem', { name: 'Make task' }))); });
        expect(drafts).toHaveLength(1);
        expect(TriageTaskDraftV1Schema.parse(drafts[0])).toMatchObject({
            title: testkitSnapshot().title,
            originError: { entryRef, display: { title: testkitSnapshot().title, scopeLabel: testkitSnapshot().scopeLabel } },
        });
    });

    it.each([false, true])('shows the saved error origin on task detail (tabbed source: %s)', async tabbedDetail => {
        const originError = { entryRef: { source: SOURCE, kindId: 'dependabot-alert', collisionScope: 'example/repository', entryId: '17' },
            display: { title: 'Original production error', scopeLabel: 'Production' } };
        const shell = await mountShell({ activeSurface: true, taskEdit: true, tabbedDetail, taskOrigin: originError,
            subPath: buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: {
                source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '657',
            } }),
        });
        await vi.waitFor(async () => {
            await expect(shell.getByRole('button', { name: 'From error: Original production error' })).resolves.toBeDefined();
        });
    });

    it.each([false, true])('opens and cancels dismissal inline in the mounted Triage detail and writes only on Submit (hosted: %s)', async (hostedDetail) => {
        const writes: PluginUiTestkitExecuteActionInput[] = [];
        const shell = await mountShell({ activeSurface: true, securityAlert: true, hostedDetail,
            onSecurityAlertWrite: request => { writes.push(request); },
            subPath: buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: {
                source: SOURCE, kindId: 'dependabot-alert', collisionScope: 'example/repository', entryId: '17',
            } }),
        });
        await measureFillRegion(1440);
        await act(async () => { await vi.waitFor(async () => {
            expect(document.body.textContent).toContain('What’s exposed');
            expect((await shell.getByRole('button', { name: 'Dismiss…' })).state?.disabled).not.toBe(true);
        }); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Dismiss…' })); });
        await act(async () => { await shell.press(await vi.waitFor(() => shell.getByRole('radio', { name: 'The alert is inaccurate' }))); });
        expect(writes).toEqual([]);
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Cancel' })); });
        expect(writes).toEqual([]);
        await expect(shell.queryByRole('radio', { name: 'The alert is inaccurate' })).resolves.toBeUndefined();
        // The generic source-actions entry reaches the same inline form and cancellation owner.
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'More actions' })); });
        await act(async () => { await shell.press(await shell.getByRole('menuitem', { name: 'Change on Example forge' })); });
        await act(async () => { await shell.press(await vi.waitFor(() => shell.getByRole('radio', { name: 'Risk is tolerable for this project' }))); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Cancel' })); });
        expect(writes).toEqual([]);
        await expect(shell.queryByRole('radio', { name: 'Risk is tolerable for this project' })).resolves.toBeUndefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Dismiss…' })); });
        expect((await vi.waitFor(() => shell.getByRole('button', { name: 'Dismiss alert' }))).state?.disabled).toBe(true);
        await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'The alert is inaccurate' })); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Dismiss alert' })); });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ action: { localId: GITHUB_SECURITY_ALERT_ACTION_IDS_V1.dismissDependabot },
            input: { reason: 'inaccurate' } });
    });

    it('round-trips an external source primary write through the real detail bridge without another detail read', async () => {
        const subPath = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: {
            source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17',
        } });
        const shell = await mountShell({ subPath, tabbedDetail: true, offerPrimaryWrite: true, activeSurface: true });
        await measureFillRegion(1440);
        await act(async () => { await vi.waitFor(async () => {
            await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
            // The header places the source's offer as its own control; the probe still reads the same offer back.
            await expect(shell.getByRole('button', { name: 'Fixture primary write' })).resolves.toBeDefined();
        }); });
        const reads = currentHarness?.readDetailInstanceIds.length;
        await act(async () => { await shell.updateSurface(surfaceContext({ tabbedDetail: true })); });
        await expect(shell.getByRole('button', { name: 'Fixture primary write' })).resolves.toBeDefined();
        expect(currentHarness?.readDetailInstanceIds.length).toBe(reads);
    });
    it('defers Account detail and fix links until requester admission without a second task inventory read', async () => {
        const harness = createHarness();
        const calls: string[] = [];
        const entryRef = TriageEntryRefV1Schema.parse({ source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' });
        const input = { selection: { entryRef, sourceInstanceId: INSTANCE }, observation: {
            entryRef, observedAtMs: 4_000, locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
        } } satisfies TriageEntryDetailInputSourceV1;
        const fixInput = { entryRef, display: { title: 'Example', scopeLabel: 'example/repository' },
            workflowSubjectOf: () => 'issue' as const, presentationOf: () => null };
        const surface = defineUiSurface(() => {
            const detail = useTriageEntryDetail(input);
            const fix = useTriageFixPullRequests(fixInput);
            // Personal order consumes the list owner's projection (TRIAGE-TASKS-READS,
            // ORCH16:14 consolidation); it must not acquire another TaskList here.
            usePersonalTaskOrder(true, undefined, () => {});
            return <Text value={`${detail?.kind}:${fix?.kind}`} />;
        });
        const context = { ...surfaceContext(), requesterExecutionReady: false,
            machineConnectionPending: false, machineExecutionReady: true };
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'detail-admission', mountNonce: 'detail-admission' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' }, surface, surfaceContext: context,
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: harness.ephemeralSharedScope }),
            handlers: { executeAction: (request): JsonValue | Promise<JsonValue> => {
                calls.push(String(request.action));
                if (request.action === 'marks/read-fix-pull-requests-v1') return { v: 1, candidates: [], primary: null, incomplete: false };
                if (request.action === 'tasks.internal.list') return { status: 'unavailable' };
                return harness.executeAction(request);
            } },
        });
        mounted.push(shell);
        expect(calls).toEqual([]);
        await expect(shell.getByText('unreachable:unreachable')).resolves.toBeDefined();
        await act(async () => { await shell.updateSurface({ ...context, requesterExecutionReady: true }); });
        await vi.waitFor(() => expect(document.body.textContent).toContain('ready:ready'));
        expect([...calls].sort()).toEqual([TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, 'marks/read-fix-pull-requests-v1'].sort());
        await act(async () => { await shell.updateSurface(context); });
        expect(calls).toHaveLength(2);
    });

    it('settles an execution-origin change with refused requester admission and recovers without a loading loop', async () => {
        const harness = createHarness();
        const shared = createTriageEphemeralSharedScopeOriginFixture();
        let scope = shared.forExecutionOrigin('machine-first');
        const entryRef = TriageEntryRefV1Schema.parse({ source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' });
        const source = { selection: { entryRef, sourceInstanceId: INSTANCE }, observation: {
            entryRef, observedAtMs: 4_000, locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
        } } satisfies TriageEntryDetailInputSourceV1;
        const calls: string[] = [];
        const surface = defineUiSurface(() => {
            const detail = useTriageEntryDetail(source);
            return <Text value={detail?.kind ?? 'none'} />;
        });
        const initial = surfaceContext();
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'detail-origin', mountNonce: 'detail-origin' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' }, surface, surfaceContext: initial,
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ get ephemeralSharedScope() { return scope; } }),
            handlers: { executeAction: request => { calls.push(String(request.action)); return harness.executeAction(request); } },
        });
        mounted.push(shell);
        await vi.waitFor(() => expect(document.body.textContent).toBe('ready'));
        scope = shared.forExecutionOrigin('machine-second');
        const refused = { ...initial, requesterExecutionReady: false };
        await act(async () => { await shell.updateSurface(refused); });
        await expect(shell.getByText('unreachable')).resolves.toBeDefined();
        for (const machineConnectionPending of [true, false, true]) {
            await act(async () => { await shell.updateSurface({ ...refused, machineConnectionPending }); });
            await expect(shell.getByText('unreachable')).resolves.toBeDefined();
        }
        expect(calls).toHaveLength(1);
        await act(async () => { await shell.updateSurface(initial); });
        await vi.waitFor(() => expect(document.body.textContent).toBe('ready'));
        expect(calls).toHaveLength(2);
    });

    it('lets an admitted Account detail read settle across requester refusal and keeps the populated entry on readmission', async () => {
        const harness = createHarness();
        const entryRef = TriageEntryRefV1Schema.parse({ source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' });
        const source = { selection: { entryRef, sourceInstanceId: INSTANCE }, observation: {
            entryRef, observedAtMs: 4_000, locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
        } } satisfies TriageEntryDetailInputSourceV1;
        let releaseRead!: () => void;
        const gate = new Promise<void>(resolve => { releaseRead = resolve; });
        const calls: AbortSignal[] = [];
        const surface = defineUiSurface(() => {
            const detail = useTriageEntryDetail(source);
            return <Text value={detail?.kind ?? 'none'} />;
        });
        const context = { ...surfaceContext(), requesterExecutionReady: true };
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'detail-refusal', mountNonce: 'detail-refusal' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' }, surface, surfaceContext: context,
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: harness.ephemeralSharedScope }),
            handlers: { executeAction: async request => {
                if (!request.signal) throw new Error('Detail reads must carry cancellation');
                calls.push(request.signal);
                await gate;
                return harness.executeAction(request);
            } },
        });
        mounted.push(shell);
        try {
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            await act(async () => { await shell.updateSurface({ ...context, requesterExecutionReady: false }); });
            expect(calls[0]!.aborted).toBe(false);
            await act(async () => { await shell.updateSurface(context); });
            expect(calls[0]!.aborted).toBe(false);
            expect(calls).toHaveLength(1);
            await act(async () => { await shell.updateSurface({ ...context, requesterExecutionReady: false }); });
            await act(async () => { releaseRead(); });
            await expect(shell.getByText('ready')).resolves.toBeDefined();
            expect(calls).toHaveLength(1);
            await act(async () => { await shell.updateSurface(context); });
            await expect(shell.getByText('ready')).resolves.toBeDefined();
            expect(calls).toHaveLength(2);
            await act(async () => { await shell.updateSurface({ ...context, requesterExecutionReady: false }); });
            await expect(shell.getByText('ready')).resolves.toBeDefined();
            expect(calls).toHaveLength(2);
        } finally { releaseRead(); }
    });

    it('settles a non-admissible Account list and preserves pending reads, retained rows and manual recovery', async () => {
        const harness = createHarness();
        const calls: string[] = [];
        let releaseRead!: () => void;
        const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
        const surface = defineUiSurface(() => {
            const window = useTriageListWindow();
            useTriageListWindowViewDemand(true, window.refresh, window.readiness, window.readOwner);
            return <><Text value={window.snapshot.window?.rows[0]?.content?.outcome.snapshot.title
                ?? (window.snapshot.error === undefined ? 'reading' : 'unavailable')} />
                <Button title="manual-window-refresh" onPress={() => window.refresh('manual')} /></>;
        });
        const context = { ...surfaceContext(), requesterExecutionReady: false,
            machineConnectionPending: true, machineExecutionReady: false };
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'account-list-admission', mountNonce: 'account-list-admission' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' }, surface,
            surfaceContext: context, adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: harness.ephemeralSharedScope }),
            handlers: { executeAction: async request => {
                calls.push(String(request.action));
                await readGate;
                return harness.executeAction(request);
            } },
        });
        mounted.push(shell);
        await expect(shell.getByText('unavailable')).resolves.toBeDefined();
        expect(calls).toEqual([]);
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'manual-window-refresh' })); });
        expect(calls).toEqual([]);
        await act(async () => { await shell.updateSurface({ ...context, requesterExecutionReady: true }); });
        await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
        await expect(shell.getByText('reading')).resolves.toBeDefined();
        await act(async () => { await shell.updateSurface(context); });
        await expect(shell.getByText('reading')).resolves.toBeDefined();
        await act(async () => { releaseRead(); });
        await vi.waitFor(() => expect(document.body.textContent).toContain('Replace the duplicated normalizer'));
        const reads = calls.length;
        await act(async () => { await shell.updateSurface(context); });
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'manual-window-refresh' })); });
        expect(calls).toHaveLength(reads);
        await act(async () => { await shell.updateSurface({ ...context, requesterExecutionReady: true }); });
        const readmitted = calls.length;
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'manual-window-refresh' })); });
        expect(calls.length).toBeGreaterThan(readmitted);
    });

    it('demands the Account aggregate list while no Machine is reachable', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
        try {
            const harness = createHarness();
            const dispatches: number[] = [];
            let rowRenders = 0;
            const Row = React.memo(({ row }: { row: NonNullable<ReturnType<typeof useTriageListWindow>['snapshot']['window']>['rows'][number] }) => {
                rowRenders += 1;
                return <Text value={row.content?.outcome.snapshot.title ?? 'reading'} />;
            });
            const surface = defineUiSurface(() => {
                const window = useTriageListWindow();
                useTriageListWindowViewDemand(true, window.refresh, window.readiness, window.readOwner);
                const row = window.snapshot.window?.rows[0];
                return row ? <Row row={row} /> : <Text value="reading" />;
            });
            const shell = await createPluginUiTestkit({ identity: { instanceId: 'account-list-read', mountNonce: 'account-list-read' },
                authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' }, surface,
                surfaceContext: { ...surfaceContext(), machineConnectionPending: true, machineExecutionReady: false },
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: harness.ephemeralSharedScope }),
                handlers: { executeAction: request => {
                    if (String(request.action) === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1
                        && TriageListEntriesInputV1Schema.parse(request.input).limit === 0) {
                        // One configured-source enumeration per refresh; subsequent reads scale with sources.
                        dispatches.push(Date.now());
                    }
                    return harness.executeAction(request);
                } },
            });
            mounted.push(shell);
            await vi.waitFor(() => { expect(document.body.textContent).toBe('Replace the duplicated normalizer'); });
            expect(dispatches[0]).toBe(0);
            expect(dispatches.every(elapsed => elapsed === 0)).toBe(true);
            const readsBeforeMachine = dispatches.length;
            const renderedBeforeMachine = rowRenders;
            await act(async () => { await shell.updateSurface({ ...surfaceContext(),
                machineConnectionPending: false, machineExecutionReady: true }); });
            await vi.waitFor(() => { expect(document.body.textContent).toBe('Replace the duplicated normalizer'); });
            expect(dispatches).toHaveLength(readsBeforeMachine + 1);
            expect(dispatches.at(-1)).toBe(0);
            expect(rowRenders - renderedBeforeMachine).toBe(0);
        } finally { clock.mockRestore(); }
    });

    it('keeps a same-entry detail acquisition while re-observation updates its current input', async () => {
        const harness = createHarness();
        const entryRef = TriageEntryRefV1Schema.parse({ source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' });
        const initial = { selection: { entryRef, sourceInstanceId: INSTANCE }, observation: {
            entryRef, observedAtMs: 4_000, sourceUpdatedAtMs: 3_000,
            locator: testkitLocator(), snapshot: testkitSnapshot({ title: 'Initial observation' }), viewer: testkitViewer(),
        } } satisfies TriageEntryDetailInputSourceV1;
        let updateSource: ((source: TriageEntryDetailInputSourceV1 | null) => void) | undefined;
        let currentObservation: TriageEntryDetailInputSourceV1['observation'] | undefined;
        let currentInstance: TriageConfiguredSourceInstanceV1 | undefined;
        let firstReadCaptured = false;
        let releaseRead!: () => void;
        const pendingRead = new Promise<void>((resolve) => { releaseRead = resolve; });
        let releaseWithdrawnRead!: () => void;
        const withdrawnRead = new Promise<void>((resolve) => { releaseWithdrawnRead = resolve; });
        const readSignals: AbortSignal[] = [];
        const surface = defineUiSurface(() => {
            const [source, setSource] = React.useState<TriageEntryDetailInputSourceV1 | null>(initial);
            updateSource = setSource;
            const detail = useTriageEntryDetail(source);
            currentObservation = detail?.kind === 'ready' ? detail.input.observation : undefined;
            currentInstance = detail?.kind === 'ready' ? detail.input.instance : undefined;
            return <Text value={detail?.kind === 'ready' ? detail.input.observation.snapshot.title : detail?.kind ?? 'none'} />;
        });
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'stable-detail-read', mountNonce: 'stable-detail-read' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            surface, surfaceContext: surfaceContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: { executeAction: async ({ action, input, signal }) => {
                if (action !== TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) throw new Error('Unexpected detail Action');
                readSignals.push(signal);
                const result = await harness.executeAction({ action, input, signal });
                if (readSignals.length === 1) {
                    firstReadCaptured = true;
                    await pendingRead;
                }
                if (readSignals.length === 5) await withdrawnRead;
                return result;
            } },
        });
        mounted.push(shell);
        try {
            await vi.waitFor(() => expect(firstReadCaptured).toBe(true));
            const row = instanceRow();
            const stored = await harness.collections.sourceInstances.get(row.instanceTag);
            if (!stored) throw new Error('Expected the configured source row');
            await harness.collections.sourceInstances.batch([{ kind: 'put', expectedRevision: stored.revision,
                value: toCorpusStoredValue({ ...row,
                    configured: { ...row.configured, configuration: { v: 1, token: 'replacement-routing-token' } },
                }),
            }]);
            const reobserved = { ...initial, selection: { ...initial.selection, entryRef: { ...entryRef, source: { ...SOURCE } } },
                observation: { ...initial.observation, observedAtMs: 5_000, snapshot: testkitSnapshot({ title: 'Current observation' }) } };
            await act(async () => {
                if (!updateSource) throw new Error('Detail source setter was not mounted');
                updateSource(reobserved);
            });
            expect(readSignals[0]?.aborted).toBe(false);
            expect(readSignals).toHaveLength(1);
            await act(async () => {
                if (!updateSource) throw new Error('Detail source setter was not mounted');
                updateSource({ ...reobserved, observation: { ...reobserved.observation, sourceUpdatedAtMs: 3_500 } });
            });
            expect(readSignals[0]?.aborted).toBe(false);
            expect(readSignals).toHaveLength(1);

            await act(async () => { releaseRead(); await pendingRead; });
            await vi.waitFor(() => expect(document.body.textContent).toBe('Current observation'));
            expect(currentObservation?.observedAtMs).toBe(5_000);
            expect(currentObservation?.sourceUpdatedAtMs).toBe(3_500);
            await vi.waitFor(() => expect(currentInstance?.configuration).toEqual({ v: 1, token: 'replacement-routing-token' }));
            expect(readSignals).toHaveLength(2);
            await act(async () => {
                if (!updateSource) throw new Error('Detail source setter was not mounted');
                updateSource({ ...reobserved, observation: { ...reobserved.observation, sourceUpdatedAtMs: 3_500 } });
            });
            expect(readSignals).toHaveLength(2);

            await act(async () => {
                if (!updateSource) throw new Error('Detail source setter was not mounted');
                updateSource({ ...reobserved, observation: { ...reobserved.observation, observedAtMs: 6_000 } });
            });
            expect(currentObservation?.observedAtMs).toBe(6_000);
            await vi.waitFor(() => expect(readSignals).toHaveLength(3));

            await act(async () => {
                if (!updateSource) throw new Error('Detail source setter was not mounted');
                updateSource({ ...reobserved, observation: { ...reobserved.observation, sourceUpdatedAtMs: 7_000 } });
            });
            await vi.waitFor(() => expect(readSignals).toHaveLength(4));
            await vi.waitFor(() => expect(currentObservation?.sourceUpdatedAtMs).toBe(7_000));
            await act(async () => {
                if (!updateSource) throw new Error('Detail source setter was not mounted');
                updateSource({ ...reobserved, observation: { ...reobserved.observation, sourceUpdatedAtMs: 8_000 } });
            });
            await vi.waitFor(() => expect(readSignals).toHaveLength(5));
            await act(async () => {
                if (!updateSource) throw new Error('Detail source setter was not mounted');
                updateSource(null);
            });
            expect(readSignals[4]?.aborted).toBe(true);
            expect(document.body.textContent).toBe('none');
            await act(async () => { releaseWithdrawnRead(); await withdrawnRead; });
            expect(document.body.textContent).toBe('none');
            expect(readSignals).toHaveLength(5);
        } finally {
            releaseRead();
            releaseWithdrawnRead();
        }
    });

    it('refreshes in-place connection configuration when the same entry is re-observed', async () => {
        const harness = createHarness();
        const entryRef = TriageEntryRefV1Schema.parse({ source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' });
        const initial = { selection: { entryRef, sourceInstanceId: INSTANCE }, observation: {
            entryRef, observedAtMs: 4_000, sourceUpdatedAtMs: 3_000,
            locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
        } } satisfies TriageEntryDetailInputSourceV1;
        let reobserve: (() => void) | undefined;
        let currentInstance: TriageConfiguredSourceInstanceV1 | undefined;
        const surface = defineUiSurface(() => {
            const [source, setSource] = React.useState<TriageEntryDetailInputSourceV1>(initial);
            reobserve = () => setSource({ ...initial, observation: { ...initial.observation, observedAtMs: 5_000 } });
            const detail = useTriageEntryDetail(source);
            currentInstance = detail?.kind === 'ready' ? detail.input.instance : undefined;
            return <Text value={detail?.kind ?? 'none'} />;
        });
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'reconfigured-detail-read', mountNonce: 'reconfigured-detail-read' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            surface, surfaceContext: surfaceContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: { executeAction: request => harness.executeAction(request) },
        });
        mounted.push(shell);
        await vi.waitFor(() => expect(currentInstance?.configuration).toEqual({ v: 1, token: 'routing-token' }));
        const row = instanceRow();
        const stored = await harness.collections.sourceInstances.get(row.instanceTag);
        if (!stored) throw new Error('Expected the configured source row');
        await harness.collections.sourceInstances.batch([{ kind: 'put', expectedRevision: stored.revision,
            value: toCorpusStoredValue({ ...row,
                configured: { ...row.configured, configuration: { v: 1, token: 'replacement-routing-token' } },
            }),
        }]);
        await act(async () => {
            if (!reobserve) throw new Error('Detail source was not mounted');
            reobserve();
        });
        await vi.waitFor(() => expect(currentInstance?.configuration).toEqual({ v: 1, token: 'replacement-routing-token' }));
    });

    it('replaces loaded relationship pages after a failed explicit reread and a subsequent observation refresh', async () => {
        const harness = createHarness();
        await harness.seedLinkedSessions(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1);
        const entryRef = TriageEntryRefV1Schema.parse({ source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' });
        const initial = { selection: { entryRef, sourceInstanceId: INSTANCE }, observation: {
            entryRef, observedAtMs: 4_000, sourceUpdatedAtMs: 3_000,
            locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
        } } satisfies TriageEntryDetailInputSourceV1;
        const detail: { current: ReturnType<typeof useTriageEntryDetail> } = { current: null };
        let reobserve: (() => void) | undefined;
        const ready = () => {
            const current = detail.current;
            if (current?.kind !== 'ready') throw new Error('Expected ready detail');
            return current;
        };
        const surface = defineUiSurface(() => {
            const [source, setSource] = React.useState<TriageEntryDetailInputSourceV1>(initial);
            reobserve = () => setSource({ ...initial, observation: { ...initial.observation, observedAtMs: 5_000 } });
            detail.current = useTriageEntryDetail(source);
            return <Text value={detail.current?.kind ?? 'none'} />;
        });
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'relationship-detail-read', mountNonce: 'relationship-detail-read' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            surface, surfaceContext: surfaceContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: { executeAction: request => harness.executeAction(request) },
        });
        mounted.push(shell);
        await vi.waitFor(() => expect(ready().linkedSessions).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1));
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: false }); });
        const beforeWithdrawalRead = harness.readDetailInstanceIds.length;
        await act(async () => { ready().loadMoreLinkedSessions(); ready().refreshLinkedSessions(); });
        expect(harness.readDetailInstanceIds).toHaveLength(beforeWithdrawalRead);
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: true }); });
        await vi.waitFor(() => expect(ready().linkedSessions).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1));
        await act(async () => { ready().loadMoreLinkedSessions(); });
        await vi.waitFor(() => expect(ready().linkedSessions).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1));
        const removed = ready().linkedSessions.at(-1);
        if (!removed) throw new Error('Expected the additional linked Session');
        await harness.executeAction({ action: 'sessions/unlink-entry-v1', input: { v: 1, entryRef, sessionId: removed.sessionId },
            signal: new AbortController().signal });
        harness.setDetailReadsUnavailable(true);
        await act(async () => { ready().refreshLinkedSessions(); });
        await vi.waitFor(() => expect(ready().linkedSessionsPageState).toBe('failed'));
        expect(ready().linkedSessions).toContainEqual(removed);

        harness.setDetailReadsUnavailable(false);
        await act(async () => {
            if (!reobserve) throw new Error('Detail source was not mounted');
            reobserve();
        });
        await vi.waitFor(() => expect(ready().linkedSessions).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1));
        expect(ready().linkedSessions).not.toContainEqual(removed);
        expect(ready().linkedSessionsPageState).toBe('idle');
    });

    it.each([false, true])('follows the declared detail transport readiness without gating direct Account reads (source-owned links: %s)', async (sourceOwned) => {
        const harness = createHarness();
        const protocol = PROTOCOL;
        const initial = surfaceContext();
        const targetedContributions = initial.targetedContributions!;
        const context = { ...initial, machineConnectionPending: true, machineExecutionReady: false,
            targetedContributions: { ...targetedContributions, points: targetedContributions.points.map(point => ({ ...point,
                protocols: point.protocols.map(candidate => ({ ...candidate,
                    contributions: candidate.contributions.map(contribution => contribution.contributor.pluginId !== SOURCE.pluginId
                        ? contribution : { ...contribution, operations: sourceOwned ? [{
                            point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
                            contributor: CONTRIBUTOR, role: 'readSessionLinks',
                            action: { pluginId: SOURCE.pluginId, localId: 'read-links' },
                        }] : [] }),
                })),
            })) } };
        const entryRef = TriageEntryRefV1Schema.parse({ source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' });
        const input = { selection: { entryRef, sourceInstanceId: INSTANCE }, observation: {
            entryRef, observedAtMs: 4_000,
            locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
        } } satisfies TriageEntryDetailInputSourceV1;
        const dataClient: PluginUiDataClient = {
            collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition) {
                const collection = definition.id === 'source-instances' ? harness.collections.sourceInstances
                    : definition.id === 'session-links' ? harness.collections.sessionLinks
                    : definition.id === 'user-marks' ? harness.collections.userMarks : null;
                if (collection === null) throw new Error(`Undeclared test Collection: ${definition.id}`);
                // Real Collection boundary fixtures share one codec; the generic definition selects its handle.
                return collection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
            },
            accountKv: createTestkitAccountKv().kv,
            openCollectionQuery: async () => { throw new Error('This detail does not open a UI query'); },
        };
        const surface = defineUiSurface(() => {
            const read = useTriageEntryDetail(input);
            return <Text value={read?.kind ?? 'none'} />;
        });
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'source-detail-read', mountNonce: 'source-detail-read' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            surface: renderContext => {
                const entry = surface(renderContext);
                if (!entry || (typeof entry.type !== 'function' && typeof entry.type !== 'object') || entry.type === null
                    || !Reflect.get(entry.type, Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'))) {
                    throw new Error('Expected the host-cloned surface entry provider');
                }
                return React.cloneElement(entry as unknown as React.ReactElement<{ dataClient?: PluginUiDataClient }>, { dataClient });
            },
            surfaceContext: context, adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: { executeAction: request => harness.executeAction(request) },
        });
        mounted.push(shell);
        await vi.waitFor(() => { expect(document.body.textContent).toBe('ready'); });
        await act(async () => { await shell.updateSurface({ ...context, machineConnectionPending: false, machineExecutionReady: true }); });
        await vi.waitFor(() => { expect(document.body.textContent).toBe('ready'); });
    });

    it('defers Account catalog acquisition and manual retry until requester admission', async () => {
        const calls: string[] = [];
        const initial = { ...surfaceContext(), requesterExecutionReady: false,
            machineConnectionPending: false, machineExecutionReady: true };
        const surface = defineUiSurface(() => {
            const actions = useTriageActions();
            const views = useTriageSavedViews();
            const pins = useTriagePinnedEntries();
            return <><Text value={actions.loaded && views.saved !== null && pins.loadMore.kind !== 'loading' ? 'ready' : 'reading'} />
                <Button title="retry-catalogs" onPress={() => { actions.retry(); views.retry(); pins.retry(); }} />
                <Button title="resolve-action" onPress={() => { void actions.resolveForExecution('missing', []); }} /></>;
        });
        const kv = createTestkitAccountKv();
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'catalog-admission', mountNonce: 'catalog-admission' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            surface, surfaceContext: initial, adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: { executeAction: async ({ action, input }) => {
                calls.push(String(action));
                if (action === 'actions/read-v1') return await readTriageActionsForSurface(TriageReadActionsInputV1Schema.parse(input), {
                    catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                });
                if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return { v: 1, pins: [] };
                return await readTriageSavedViewsForSurface(TriageReadSavedViewsInputV1Schema.parse(input), {
                    catalog: kv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: () => 'unused',
                });
            } },
        });
        mounted.push(shell);
        expect(calls).toEqual([]);
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'retry-catalogs' })); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'resolve-action' })); });
        expect(calls).toEqual([]);
        await act(async () => { await shell.updateSurface({ ...initial, requesterExecutionReady: true }); });
        await vi.waitFor(() => expect(document.body.textContent).toContain('ready'));
        expect(calls).toHaveLength(3);
        await act(async () => { await shell.updateSurface(initial); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'retry-catalogs' })); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'resolve-action' })); });
        expect(calls).toHaveLength(3);
    });

    it.each([false, true])('reads Account catalogs without a Machine and recovers an actual host refusal (withdrawn: %s)', async (initiallyWithdrawn) => {
        let withdrawn = initiallyWithdrawn;
        const kv = createTestkitAccountKv();
        const initial = { ...surfaceContext(), machineConnectionPending: true, machineExecutionReady: false };
        const surface = defineUiSurface(() => {
            const actions = useTriageActions();
            const views = useTriageSavedViews();
            const pins = useTriagePinnedEntries();
            return <Text value={actions.unavailableReason || views.unavailableReason || pins.unavailableReason ? 'error'
                : actions.loaded && views.saved !== null && pins.loadMore.kind !== 'loading' ? 'ready' : 'reading'} />;
        });
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'catalog-read', mountNonce: 'catalog-read-nonce' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            surface, surfaceContext: initial, adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: { executeAction: async ({ action, input }) => {
                if (withdrawn) throw new PluginError({ code: 'unavailable', retryable: true,
                    diagnostics: [{ code: 'plugin_mounted_caller_unavailable', severity: 'error' }] });
                if (action === 'actions/read-v1') return await readTriageActionsForSurface(TriageReadActionsInputV1Schema.parse(input), {
                    catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                });
                if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return { v: 1, pins: [] };
                return await readTriageSavedViewsForSurface(TriageReadSavedViewsInputV1Schema.parse(input), {
                    catalog: kv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: () => 'unused',
                });
            } },
        });
        mounted.push(shell);
        await vi.waitFor(() => { expect(document.body.textContent).toBe(initiallyWithdrawn ? 'error' : 'ready'); });
        withdrawn = false;
        await act(async () => { await shell.updateSurface({ ...initial, requesterExecutionReady: false }); });
        await act(async () => { await shell.updateSurface({ ...initial, requesterExecutionReady: true }); });
        await vi.waitFor(async () => { await expect(shell.getByText('ready')).resolves.toBeDefined(); });
    });

    it('surfaces an actual Account detail refusal and reacquires it on host re-admission', async () => {
        const refusedHostReads = new Set([TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1]);
        const shell = await mountShell({ refusedHostReads, activeSurface: true });
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), machineConnectionPending: true, machineExecutionReady: false }); });
        await openTheRow(shell);
        await expect(shell.getByText('These details could not be read')).resolves.toBeDefined();
        refusedHostReads.clear();
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: false }); });
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: true }); });
        await vi.waitFor(async () => { await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined(); });
    });

    it.each([false, true])('reads Account fix-PR links without a Machine and recovers an actual host refusal (withdrawn: %s)', async (initiallyWithdrawn) => {
        let withdrawn = initiallyWithdrawn;
        const input = { entryRef: {
            source: SOURCE, kindId: 'issue', collisionScope: 'example/repository', entryId: '17',
        }, display: { title: 'Example issue', scopeLabel: 'example/repository' },
            workflowSubjectOf: () => 'issue' as const, presentationOf: () => null };
        const initial = { ...surfaceContext(), machineConnectionPending: true, machineExecutionReady: false };
        // Fixed input identities isolate the shared read lifecycle from list
        // refreshes or descriptor replacement that could independently reread.
        const surface = defineUiSurface(() => {
            const read = useTriageFixPullRequests(input);
            return <Text value={read?.kind ?? 'none'} />;
        });
        const shell = await createPluginUiTestkit({ identity: { instanceId: 'fix-read', mountNonce: 'fix-read-nonce' },
            authorPlugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
            surface, surfaceContext: initial, adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: { executeAction: async () => {
                if (withdrawn) throw new PluginError({ code: 'unavailable', retryable: true,
                    diagnostics: [{ code: 'plugin_mounted_caller_unavailable', severity: 'error' }] });
                return { v: 1, candidates: [], primary: null, incomplete: false };
            } },
        });
        mounted.push(shell);
        await vi.waitFor(() => { expect(document.body.textContent).toBe(initiallyWithdrawn ? 'unreachable' : 'ready'); });
        withdrawn = false;
        await act(async () => { await shell.updateSurface({ ...initial, requesterExecutionReady: false }); });
        await act(async () => { await shell.updateSurface({ ...initial, requesterExecutionReady: true }); });
        await vi.waitFor(async () => { await expect(shell.getByText('ready')).resolves.toBeDefined(); });
    });

    it('reacquires a refused cold read when exact requester execution is re-admitted after loading settled', async () => {
        const hostTarget = { ready: false, pending: false, executionReady: false };
        const shell = await mountShell({ hostTarget, activeSurface: true, automaticDemandOnly: true });
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        hostTarget.ready = true;
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: false }); });
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: true }); });
        await vi.waitFor(async () => {
            await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
        });
        await expect(shell.queryByText('The list could not be read')).resolves.toBeUndefined();
    });

    it('offers Retry beside an Account aggregate refusal and reacquires through the mounted window', async () => {
        const hostTarget = { ready: false, pending: false };
        const shell = await mountShell({ hostTarget });
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Try again' })).resolves.toBeDefined();
        hostTarget.ready = true;
        await act(async () => { await shell.updateSurface(surfaceContext()); });
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Try again' })); });
        await vi.waitFor(async () => {
            await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
        });
        await expect(shell.queryByText('The list could not be read')).resolves.toBeUndefined();
    });
    it('shows the detail refusal code and request ID without offering Retry for a permanent refusal', async () => {
        const shell = await mountShell({ detailFailure: new PluginError({ code: 'machine_not_found', retryable: false,
            details: { requestId: 'detail-request-51' }, diagnostics: [{ code: 'target_machine_required', severity: 'error' }] }) });
        await openTheRow(shell);
        await expect(shell.getByText('These details could not be read')).resolves.toBeDefined();
        await expect(shell.queryByText('This connection is no longer configured')).resolves.toBeUndefined();
        await expect(shell.queryByRole('button', { name: 'Retry' })).resolves.toBeUndefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Details' })); });
        expect(document.body.textContent).toContain('machine_not_found');
        expect(document.body.textContent).toContain('target_machine_required');
        expect(document.body.textContent).toContain('detail-request-51');
    });

    it('publishes linked Session selection commands with current public titles', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const shell = await mountShell({ linkedSessionCount: 1, activeSurface: true,
            sessionTitle: 'Current investigation', publishCurrentUiContext: (value) => { published = value; } });
        await openTheRow(shell);
        await vi.waitFor(() => expect(published?.commands?.some((command) => command.title === 'Select session Current investigation')).toBe(true));
    });
    it('retains an Account read failure during Machine loading and recovers when it becomes available', async () => {
        const hostTarget = { ready: false, pending: false };
        let reads = 0;
        const shell = await mountShell({ activeSurface: true, hostTarget, automaticDemandOnly: true,
            onAggregateRead: () => { reads += 1; } });
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        const previousReads = reads;
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), machineConnectionPending: true }); });
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        expect(reads).toBe(previousReads);
        hostTarget.ready = true;
        await act(async () => { await shell.updateSurface(surfaceContext()); });
        await vi.waitFor(async () => {
            await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
        });
        await expect(shell.queryByText('The list could not be read')).resolves.toBeUndefined();
        // Restoring the host also restores its admitted source descriptors;
        // both source admission and readiness can demand the shared window.
        expect(reads).toBeGreaterThan(previousReads);
        const recoveredReads = reads;
        await act(async () => { await shell.updateSurface(surfaceContext()); });
        expect(reads).toBe(recoveredReads);
    });

    it('attempts the Account aggregate during Machine loading and keeps Account controls available after refusal', async () => {
        const hostTarget = { ready: false };
        let reads = 0;
        const shell = await mountShell({ activeSurface: true, hostTarget, automaticDemandOnly: true,
            onAggregateRead: () => { reads += 1; } });
        await act(async () => { await Promise.resolve(); });
        expect(reads).toBeGreaterThan(0);
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Views: No saved view' })); });
        await expect(shell.getByRole('menuitemradio', { name: 'No saved view' })).resolves.toBeDefined();
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();

        hostTarget.ready = true;
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: false }); });
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), requesterExecutionReady: true }); });
        await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
    });

    it('keeps the declared Files and Checks tabs when the fix PR is outside the projection', async () => {
        const shell = await mountShell({ fixPullRequestState: 'unprojected' });
        await openTheRow(shell);
        await act(async () => { await shell.press(await shell.findByRole('tab', { name: 'Files' })); });
        await expect(shell.getByText("This source's detail view is unavailable")).resolves.toBeDefined();
        await expect(shell.getByRole('tab', { name: 'Checks' })).resolves.toBeDefined();
    });

    it('shows a fix-PR relationship read failure and retries within the selected detail', async () => {
        const shell = await mountShell({ fixPullRequestState: 'unreachable' });
        await openTheRow(shell);
        await expect(shell.getByText('Fix pull request links could not be read.')).resolves.toBeDefined();
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.findByRole('button', { name: 'Retry: Fix pull request' })); });
        // The retried read lands as the fix step, named after the pull request.
        expect(document.querySelector('[data-testid="triage-story-fix-pr"]')?.textContent).toContain('Unprojected fix');
    });
    it('lets an agent switch the mounted Collection to Board through the UI owner', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const shell = await mountShell({ activeSurface: true, publishCurrentUiContext: (context) => { published = context; } });
        const command = (published as PluginUiContextEnrichmentV1 | null)?.commands?.find((entry) => entry.title === 'Switch to Board');
        expect(command).toBeDefined();
        if (command?.command.kind !== 'executeAction') throw new Error('Expected the mounted action');
        const input = TriageMountedUiInputV1Schema.parse(command.command.input);
        const { createTriageMountedUiActionHandler } = await import('../actions/mountedUi.js');
        const invoke = () => createTriageMountedUiActionHandler()(input, {
            plugin: { id: 'happier.triage', version: '0.0.0' },
            contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
            invocationSurface: 'agent', signal: new AbortController().signal,
            ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
        });
        await act(async () => {
            expect(await invoke()).toEqual({ status: 'applied' });
        });
        expect(document.querySelector('[role="radio"][aria-label="Board"][aria-checked="true"]')).not.toBeNull();
        await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'List' })); });
        expect(document.querySelector('[role="radio"][aria-label="List"][aria-checked="true"]')).not.toBeNull();
        await act(async () => { await shell.dispose(); });
        await expect(invoke()).resolves.toEqual({ status: 'unavailable' });
    });

    it('gives the Session tab the pushed page: the task properties step aside while it is open', async () => {
        const shell = await mountShell({ linkedSessionCount: 1, activeSurface: true, taskEdit: true });
        await openTheRow(shell);
        const properties = () => document.querySelector(`[data-testid="${TRIAGE_TASK_PROPERTIES_TEST_ID_V1}"]`);
        await vi.waitFor(() => expect(properties()).not.toBeNull());
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Session' })); });
        expect(properties()).toBeNull();
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Overview' })); });
        await vi.waitFor(() => expect(properties()).not.toBeNull());
    });

    it('rereads the relationship after unlink and stops presenting the removed Session', async () => {
        const shell = await mountShell({ linkedSessionCount: 2, activeSurface: true });
        await openTheRow(shell);
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Session' })); });
        const picker = (await shell.getAllByRole('button')).find(button => button.name?.startsWith('Linked session:'));
        if (!picker) throw new Error('Missing linked Session picker');
        await act(async () => { await shell.press(picker); });
        await act(async () => { await shell.press(await shell.getByRole('menuitemradio', { name: 'Linked session-linked-002' })); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Unlink' })); });
        const harness = currentHarness;
        if (!harness) throw new Error('Missing mounted harness');
        const links = await harness.collections.sessionLinks.query({ index: 'by-session', prefix: ['session-linked-002'], order: 'asc' });
        expect(links.rows).toHaveLength(0);
        await expect(shell.queryByRole('group', { name: 'Session session-linked-002' })).resolves.toBeUndefined();
        await expect(shell.getByRole('group', { name: 'Session session-linked-001' })).resolves.toBeDefined();
    });

    it.each(['reject', 'unavailable'] as const)('reports a typed failure when the linked Session picker cannot apply: %s', async (mountedActionFailure) => {
        const notices: Readonly<{ message: string; severity?: string }>[] = [];
        const diagnostics: Readonly<{ code: string }>[] = [];
        const shell = await mountShell({ linkedSessionCount: 2, activeSurface: true, mountedActionFailure,
            onNotification: (notice) => { notices.push(notice); }, onDiagnostic: (data) => { diagnostics.push(data); } });
        await openTheRow(shell);
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Session' })); });
        const picker = (await shell.getAllByRole('button')).find(button => button.name?.startsWith('Linked session:'));
        if (!picker) throw new Error('Missing linked Session picker');
        await act(async () => { await shell.press(picker); });
        const choices = await shell.getAllByRole('menuitemradio');
        expect(choices).toHaveLength(2);
        await act(async () => { await shell.press(await shell.getByRole('menuitemradio', { name: 'Linked session-linked-002' })); });
        await vi.waitFor(() => expect(notices).toEqual([expect.objectContaining({ severity: 'error' })]));
        expect(diagnostics).toContainEqual(expect.objectContaining({ code: mountedActionFailure === 'reject'
            ? 'plugin_surface_client_action_unavailable' : 'triage_mounted_ui_unavailable' }));
    });

    it('lets an agent select a linked Session in the same inline detail as the UI picker', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const shell = await mountShell({ linkedSessionCount: 2, activeSurface: true,
            publishCurrentUiContext: (context) => { published = context; } });
        await openTheRow(shell);
        const context = () => published as PluginUiContextEnrichmentV1 | null;
        const command = context()?.commands?.find((entry) => entry.command.kind === 'executeAction'
            && typeof entry.command.input === 'object' && entry.command.input !== null
            && JSON.stringify(entry.command.input).includes('selectLinkedSession'));
        if (command?.command.kind !== 'executeAction') throw new Error('Missing linked-session command');
        const address = TriageMountedUiInputV1Schema.parse(command.command.input);
        const { createTriageMountedUiActionHandler } = await import('../actions/mountedUi.js');
        const invoke = async (sessionId: string) => createTriageMountedUiActionHandler()(
            { mountId: address.mountId, operation: { kind: 'selectLinkedSession', sessionId } }, {
                plugin: { id: 'happier.triage', version: '0.0.0' },
                contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
            });
        await act(async () => { expect(await invoke('session-linked-002')).toEqual({ status: 'applied' }); });
        await expect(shell.getByRole('group', { name: 'Session session-linked-002' })).resolves.toBeDefined();
        expect(context()?.detail).toMatchObject({ linkedSessionIds: expect.arrayContaining(['session-linked-001', 'session-linked-002']),
            selectedLinkedSessionId: 'session-linked-002' });
        await act(async () => { expect(await invoke('unlinked')).toEqual({ status: 'unavailable' }); });
        await expect(shell.getByRole('group', { name: 'Session session-linked-002' })).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Linked session: Linked session-linked-002' })); });
        await act(async () => { await shell.press(await shell.getByRole('menuitemradio', { name: 'Linked session-linked-001' })); });
        await expect(shell.getByRole('group', { name: 'Session session-linked-001' })).resolves.toBeDefined();
        expect(context()?.detail).toMatchObject({ selectedLinkedSessionId: 'session-linked-001' });
        await act(async () => { await shell.dispose(); });
        expect(await invoke('session-linked-002')).toEqual({ status: 'unavailable' });
    });

    it('publishes the detail Items through the installed page navigation host operation', async () => {
        const descriptors: (PluginUiPageNavigationV1 | null)[] = [];
        const shell = await mountShell({ activeSurface: true, tabbedDetail: true,
            onPageNavigation: navigation => { descriptors.push(navigation); } });
        await openTheRow(shell);
        expect(descriptors.at(-1)).toMatchObject({ pageKind: { pluginId: 'happier.triage', localId: 'entry' },
            value: 'overview', items: expect.arrayContaining([{ value: 'overview', title: 'Overview', kind: 'page', glyph: 'info', phonePlacement: 'bar' }]) });
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Files' })); });
        expect(descriptors.at(-1)).toMatchObject({ value: 'files' });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Back' })); });
        await vi.waitFor(() => expect(descriptors.at(-1)).toBeNull());
    });

    it.each([['tabbed', true], ['whole', false]] as const)('publishes the %s detail Session item as a page tab and its companion', async (_body, tabbedDetail) => {
        const descriptors: (PluginUiPageNavigationV1 | null)[] = [];
        const shell = await mountShell({ activeSurface: true, tabbedDetail, linkedSessionCount: 1,
            onPageNavigation: navigation => { descriptors.push(navigation); } });
        await openTheRow(shell);
        await vi.waitFor(() => expect(descriptors.at(-1)?.items).toContainEqual(expect.objectContaining({
            value: 'session', kind: 'both', companion: { pluginId: 'happier.triage', localId: 'entry-linked-session' },
        })));
    });

    it('shows the opening page’s selected entry’s linked Session in the companion', async () => {
        const shell = await mountShell({ activeSurface: true, linkedSessionCount: 1 });
        await openTheRow(shell);
        const subPath = lastPageLocation?.subPath ?? null;
        expect(subPath).not.toBeNull();
        await expect(shell.queryByRole('group', { name: 'Session session-linked-001' })).resolves.toBeUndefined();
        const companion = await mountEntrySessionCompanion({ subPath });
        await vi.waitFor(async () => {
            await expect(companion.getByRole('group', { name: 'Session session-linked-001' })).resolves.toBeDefined();
        });
    });

    it('names the companion’s Session in its pane header, with Open session and Unlink beside it', async () => {
        const shell = await mountShell({ activeSurface: true, linkedSessionCount: 1 });
        await openTheRow(shell);
        const companion = await mountEntrySessionCompanion({ subPath: lastPageLocation?.subPath ?? null }, { paneHeader: true });
        await vi.waitFor(async () => {
            await expect(companion.getByRole('group', { name: 'Session session-linked-001' })).resolves.toBeDefined();
        });
        // The header the host draws carries the Session's name and its two quiet actions; the body is the Session.
        await expect(companion.getByRole('group', { name: 'Pane header' })).resolves.toBeDefined();
        await expect(companion.getByText('Linked session-linked-001')).resolves.toBeDefined();
        await expect(companion.getByRole('button', { name: 'Open session' })).resolves.toBeDefined();
        await expect(companion.getByRole('button', { name: 'Unlink' })).resolves.toBeDefined();
    });

    it('finds the opening page’s entry by itself, without the page’s list window', async () => {
        const shell = await mountShell({ activeSurface: true, linkedSessionCount: 1 });
        await openTheRow(shell);
        const subPath = lastPageLocation?.subPath ?? null;
        expect(subPath).not.toBeNull();
        const companion = await mountEntrySessionCompanion({ subPath }, { ownScope: true });
        await vi.waitFor(async () => {
            await expect(companion.getByRole('group', { name: 'Session session-linked-001' })).resolves.toBeDefined();
        });
    });

    it('says so when the opening page’s entry has no linked Session', async () => {
        const shell = await mountShell({ activeSurface: true });
        await openTheRow(shell);
        const companion = await mountEntrySessionCompanion({ subPath: lastPageLocation?.subPath ?? null });
        await vi.waitFor(async () => {
            await expect(companion.getByText('No Session is linked to this entry.')).resolves.toBeDefined();
        });
    });

    it.each([['no opener', undefined], ['no selection', { subPath: null }]] as const)('keeps the companion quiet with %s', async (_case, openedFrom) => {
        await mountShell({ activeSurface: true, linkedSessionCount: 1 });
        const companion = await mountEntrySessionCompanion(openedFrom);
        await expect(companion.getByText('Open an entry to follow its Session here.')).resolves.toBeDefined();
        await expect(companion.queryByRole('group', { name: 'Session session-linked-001' })).resolves.toBeUndefined();
    });

    it('lets an agent focus and peek a row without selecting its detail', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const publications: (PluginUiContextEnrichmentV1 | null)[] = [];
        const shell = await mountShell({ activeSurface: true, publishCurrentUiContext: (context) => {
            published = context;
            publications.push(context);
        } });
        await measureFillRegion(1440);
        const command = (published as PluginUiContextEnrichmentV1 | null)?.commands?.find((entry) => entry.title === 'Switch to Board');
        if (command?.command.kind !== 'executeAction') throw new Error('Expected the mounted action');
        const address = TriageMountedUiInputV1Schema.parse(command.command.input);
        const { createTriageMountedUiActionHandler } = await import('../actions/mountedUi.js');
        const invoke = async (kind: 'focusRow' | 'peekRow', options: { entryId?: string; expanded?: boolean } = {}) => await createTriageMountedUiActionHandler()(
            TriageMountedUiInputV1Schema.parse({ mountId: address.mountId, operation: { kind, entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: options.entryId ?? '17' },
                ...(options.expanded === undefined ? {} : { expanded: options.expanded }) } }),
            {
                plugin: { id: 'happier.triage', version: '0.0.0' },
                contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
            },
        );
        const beforeFocus = published;
        const publicationsBeforeFocus = publications.length;
        await act(async () => { expect(await invoke('focusRow')).toEqual({ status: 'applied' }); });
        expect(activeElementName()).toContain('Replace the duplicated normalizer');
        expect(queryDetailBodyNode()).toBeNull();
        // Focus is not an Action target or a route change. Publishing the same
        // context again retires/recreates the host's opaque command addresses.
        expect(published).toEqual(beforeFocus);
        expect(publications).toHaveLength(publicationsBeforeFocus);
        expect(published).toBe(beforeFocus);
        await act(async () => { expect(await invoke('focusRow', { entryId: 'missing' })).toEqual({ status: 'unavailable' }); });
        expect(activeElementName()).toContain('Replace the duplicated normalizer');
        await act(async () => { expect(await invoke('peekRow')).toEqual({ status: 'applied' }); });
        await act(async () => { expect(await invoke('peekRow')).toEqual({ status: 'applied' }); });
        await expect(shell.getByRole('button', { name: 'Open' })).resolves.toBeDefined();
        // The peek reaches the entry where it lives, as the detail header does, without opening the detail.
        await expect(shell.getByRole('button', { name: 'Open at the source' })).resolves.toBeDefined();
        expect(queryDetailBodyNode()).toBeNull();
        await act(async () => { expect(await invoke('peekRow', { expanded: false })).toEqual({ status: 'applied' }); });
        await expect(shell.queryByRole('button', { name: 'Open' })).resolves.toBeUndefined();
        await act(async () => { expect(await invoke('peekRow')).toEqual({ status: 'applied' }); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Open' })); });
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        expect(publications.length).toBeGreaterThan(publicationsBeforeFocus);
        expect(published).not.toBe(beforeFocus);
    });

    it.each([0, 1])('keeps source session and host Session destinations distinct through mounted Actions (%s linked)', async (linkedSessionCount) => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const shell = await mountShell({ activeSurface: true, sourceSessionTab: true, linkedSessionCount,
            publishCurrentUiContext: (context) => { published = context; } });
        await openTheRow(shell);
        const sourceCommand = (published as PluginUiContextEnrichmentV1 | null)?.commands?.find(
            (entry) => entry.title === 'Select Session history tab');
        if (sourceCommand?.command.kind !== 'executeAction') throw new Error('Missing source panel selection command');
        const address = TriageMountedUiInputV1Schema.parse(sourceCommand.command.input);
        const { createTriageMountedUiActionHandler } = await import('../actions/mountedUi.js');
        const invoke = async (operation: typeof address.operation) => await createTriageMountedUiActionHandler()(
            { mountId: address.mountId, operation }, {
                plugin: { id: 'happier.triage', version: '0.0.0' },
                contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
            });
        await act(async () => { expect(await invoke(address.operation)).toEqual({ status: 'applied' }); });
        await expect(shell.getByRole('tab', { name: 'Session history', state: { selected: true } })).resolves.toBeDefined();
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Files' })); });
        await expect(shell.getByRole('tab', { name: 'Files', state: { selected: true } })).resolves.toBeDefined();
        if (linkedSessionCount > 0) {
            await act(async () => { expect(await invoke({ kind: 'selectDetailTab', tab: 'session' })).toEqual({ status: 'applied' }); });
            await expect(shell.getByRole('group', { name: 'Session session-linked-001' })).resolves.toBeDefined();
            await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        } else {
            expect(await invoke({ kind: 'selectDetailTab', tab: 'session' })).toEqual({ status: 'unavailable' });
        }
        await act(async () => { expect(await invoke({ kind: 'closeDetail' })).toEqual({ status: 'applied' }); });
        if (address.operation.kind !== 'selectDetailTab') throw new Error('Expected a source tab selection');
        const tab = address.operation.tab;
        await act(async () => { expect(await invoke({ kind: 'openDetail', entryRef: {
            source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17',
        }, tab })).toEqual({ status: 'applied' }); });
        await expect(shell.getByRole('tab', { name: 'Session history', state: { selected: true } })).resolves.toBeDefined();
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
    });

    it('lets an agent open an entry on Checks and keeps UI tab presses on the same owner', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const shell = await mountShell({ activeSurface: true, tabbedDetail: true, publishCurrentUiContext: (context) => { published = context; } });
        const command = (published as PluginUiContextEnrichmentV1 | null)?.commands?.find((entry) => entry.title === 'Switch to Board');
        expect(command).toBeDefined();
        if (command?.command.kind !== 'executeAction') throw new Error('Expected the mounted action');
        const { createTriageMountedUiActionHandler } = await import('../actions/mountedUi.js');
        const address = TriageMountedUiInputV1Schema.parse(command.command.input);
        await act(async () => {
            expect(await createTriageMountedUiActionHandler()({ mountId: address.mountId, operation: {
                kind: 'openDetail', entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' }, tab: 'checks',
            } }, {
                plugin: { id: 'happier.triage', version: '0.0.0' },
                contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
            })).toEqual({ status: 'applied' });
        });
        expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Checks');
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Activity' })); });
        expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Activity');
        await expect(shell.getByRole('tab', { name: 'Activity', state: { selected: true } })).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Checks' })); });
        await expect(shell.getByRole('tab', { name: 'Checks', state: { selected: true } })).resolves.toBeDefined();
    });

    it('retries a detail-read failure without closing the selected entry', async () => {
        const shell = await mountShell();
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        harness.setDetailReadsUnavailable(true);

        await openTheRow(shell);

        await expect(shell.getByText('These details could not be read')).resolves.toBeDefined();
        await expect(shell.getByRole('heading', { name: 'Replace the duplicated normalizer' }))
            .resolves.toBeDefined();
        harness.setDetailReadsUnavailable(false);
        await act(async () => {
            pressDetailButton('Retry');
        });
        for (let settle = 0; settle < 4; settle += 1) {
            await act(async () => { await Promise.resolve(); });
        }

        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        await expect(shell.queryByText('These details could not be read')).resolves.toBeUndefined();
    });

    it('restores the settled list and announces a host-rejected selection', async () => {
        const shell = await mountShell({
            replacePageLocation: async () => { throw new Error('host rejected replacement'); },
        });

        await openTheRow(shell);

        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer' }))
            .resolves.toBeDefined();
        await expect(shell.getByText('This page could not be updated')).resolves.toBeDefined();
    });

    it.each([false, true])('adopts only the newest host-canonical location when an earlier acknowledgement is delayed (successor refused: %s)', async (refuseSuccessor) => {
        let settleFirst!: (subPath: string) => void;
        const first = new Promise<string>((resolve) => { settleFirst = resolve; });
        let calls = 0;
        const canonicalQuery = 'x';
        const longEntryRef = TriageEntryRefV1Schema.parse({
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: LONG_SCOPE,
            entryId: LONG_ENTRY_ID,
        });
        const canonicalSecond = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            query: canonicalQuery,
            selection: longEntryRef,
        });
        const shell = await mountShell({
            replacePageLocation: async () => {
                calls += 1;
                if (calls === 1) return await first;
                if (refuseSuccessor) throw new Error('host rejected successor');
                return canonicalSecond;
            },
        });
        await measureFillRegion(900);

        await openTheRow(shell);
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        await act(async () => { await Promise.resolve(); });
        await expect(shell.getByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();

        // The host publishes A before acknowledging its in-flight replacement.
        // That is this queue's own older write, not an external Back step.
        await act(async () => {
            await shell.updatePageLocation(buildTriageRouteSubPathV1({
                ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                selection: {
                    source: SOURCE,
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: '17',
                },
            }));
        });
        await expect(shell.getByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();

        // A's returned location is deliberately stale and canonicalized. It is
        // now the host's temporary base for B, but it must never repaint A over
        // the newer optimistic B selection.
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), textScale: 1.25 }); });
        await expect(shell.getByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        await act(async () => {
            settleFirst(buildTriageRouteSubPathV1({
                ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                query: 'stale',
                selection: {
                    source: SOURCE,
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: '17',
                },
            }));
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        expect(calls).toBe(2);

        if (refuseSuccessor) {
            // A became the rollback base without repainting over B. Only B's
            // later refusal makes that base visible, including its host lens.
            await expect(shell.getByRole('heading', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
            expect((await shell.getByRole('textbox')).value).toBe('stale');
            await expect(shell.getByText('This page could not be updated')).resolves.toBeDefined();
            return;
        }
        await expect(shell.getByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        expect((await shell.getByRole('textbox')).value).toBe(canonicalQuery);
        await expect(shell.queryByText('This page could not be updated')).resolves.toBeUndefined();
    });

    it('adopts a genuine external Back while an older route write and its successor are outstanding', async () => {
        let settleFirst!: (subPath: string) => void;
        const first = new Promise<string>((resolve) => { settleFirst = resolve; });
        let firstPath = '';
        let calls = 0;
        let rejectNext = false;
        const shell = await mountShell({
            replacePageLocation: async ({ subPath }) => {
                calls += 1;
                if (calls !== 1) {
                    if (rejectNext) throw new Error('host rejected new selection');
                    await shell.updatePageLocation(subPath);
                    return subPath;
                }
                firstPath = subPath;
                return await first;
            },
        });
        await measureFillRegion(900);
        await openTheRow(shell);
        await act(async () => { await shell.updatePageLocation(firstPath); });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        await expect(shell.getByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();

        // Back from the published A to the original list is neither the issued
        // A nor the pending B, even though both writes are still outstanding.
        await act(async () => { await shell.updatePageLocation(''); });
        await expect(shell.queryByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeUndefined();
        await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
        expect((await shell.getByRole('textbox')).value).toBe('');
        await act(async () => {
            settleFirst(firstPath);
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        await expect(shell.queryByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeUndefined();
        expect((await shell.getByRole('textbox')).value).toBe('');
        expect(calls).toBe(1);
        rejectNext = true;
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        // The old acknowledgement cannot replace Back's rollback base either.
        await expect(shell.getByText('This page could not be updated')).resolves.toBeDefined();
        await expect(shell.queryByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeUndefined();
        await expect(shell.queryByRole('heading', { name: 'Replace the duplicated normalizer' })).resolves.toBeUndefined();
        await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
    });

    it('pages linked Sessions through the same mounted detail controller as the UI and retries its failed page', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const shell = await mountShell({ linkedSessionCount: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1, activeSurface: true,
            publishCurrentUiContext: (context) => { published = context; } });
        await openTheRow(shell);
        const command = (published as PluginUiContextEnrichmentV1 | null)?.commands?.find((entry) => entry.command.kind === 'executeAction'
            && JSON.stringify(entry.command.input).includes('linkedSessions') && JSON.stringify(entry.command.input).includes('loadMore'));
        expect(command).toBeDefined();
        if (command?.command.kind !== 'executeAction') throw new Error('Missing linked-session paging command');
        const input = TriageMountedUiInputV1Schema.parse(command.command.input);
        const { createTriageMountedUiActionHandler } = await import('../actions/mountedUi.js');
        const invoke = () => createTriageMountedUiActionHandler()(input, {
            plugin: { id: 'happier.triage', version: '0.0.0' },
            contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
            invocationSurface: 'agent', signal: new AbortController().signal,
            ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
        });
        currentHarness!.failNextLinkedSessionPage();
        await act(async () => { expect(await invoke()).toEqual({ status: 'applied' }); });
        await expect(shell.getByText('More linked Sessions could not be loaded.')).resolves.toBeDefined();
        await act(async () => { expect(await invoke()).toEqual({ status: 'applied' }); });
        await expect(shell.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        const linkedNames = async (page: PluginUiTestkit) => (await page.getAllByRole('button'))
            .map((button) => button.name).filter((name) => name === 'Linked Session 201' || name?.startsWith('Linked session-linked-'));
        const agentRows = await linkedNames(shell);
        expect(agentRows).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1);
        expect(await invoke()).toEqual({ status: 'unavailable' });
        await act(async () => { await shell.dispose(); });
        expect(await invoke()).toEqual({ status: 'unavailable' });
        const ui = await mountShell({ linkedSessionCount: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1, activeSurface: true });
        await openTheRow(ui);
        await act(async () => { pressDetailButton('Load more'); });
        await expect(ui.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        expect(await linkedNames(ui)).toEqual(agentRows);
        // Two full 201-row mounts plus the failed-page retry exceed the single-mount default.
    }, 15_000);

    it('loads another linked-Session page without dropping or duplicating earlier rows, and retries a failed page', async () => {
        // UI paging uses the mounted Action owner, which is bound only while the host page is active.
        const shell = await mountShell({ linkedSessionCount: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1, activeSurface: true });
        await openTheRow(shell);

        const initialLinkedSessionNames = (await shell.getAllByRole('button'))
            .map((button) => button.name)
            .filter((name) => name?.startsWith('Linked session-linked-'));
        expect(initialLinkedSessionNames).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1);
        const firstLinkedSessionName = initialLinkedSessionNames[0];
        if (firstLinkedSessionName === undefined) throw new Error('The first linked Session page was empty.');
        const firstLinkedSessionNode = Array.from(document.querySelectorAll('*')).find(
            (candidate) => candidate.textContent === firstLinkedSessionName
                && !Array.from(candidate.children).some((child) => child.textContent === firstLinkedSessionName),
        );
        if (firstLinkedSessionNode === undefined) throw new Error('The first linked Session row was not mounted.');
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        harness.failNextLinkedSessionPage();

        await act(async () => {
            pressDetailButton('Load more');
        });
        await expect(shell.getByText('More linked Sessions could not be loaded.')).resolves.toBeDefined();
        await expect(shell.queryByText('Linked Session 201')).resolves.toBeUndefined();

        await act(async () => {
            pressDetailButton('Retry');
        });

        await expect(shell.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: firstLinkedSessionName })).resolves.toBeDefined();
        const retainedFirstLinkedSessionNode = Array.from(document.querySelectorAll('*')).find(
            (candidate) => candidate.textContent === firstLinkedSessionName
                && !Array.from(candidate.children).some((child) => child.textContent === firstLinkedSessionName),
        );
        expect(retainedFirstLinkedSessionNode).toBe(firstLinkedSessionNode);
        const loadedLinkedSessionNames = (await shell.getAllByRole('button'))
            .map((button) => button.name)
            .filter((name) => name === 'Linked Session 201' || name?.startsWith('Linked session-linked-'));
        expect(loadedLinkedSessionNames).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1);
        expect(new Set(loadedLinkedSessionNames).size)
            .toBe(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1);
        expect(queryDetailButton('Load more')).toBeUndefined();
        expect(queryDetailButton('Retry')).toBeUndefined();
    });

    it('settles a non-advancing linked-Session cursor while retaining the admitted page', async () => {
        const shell = await mountShell({ linkedSessionCount: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1, activeSurface: true });
        await openTheRow(shell);
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        harness.repeatNextLinkedSessionCursor();

        await act(async () => {
            pressDetailButton('Load more');
        });

        // The page itself was admitted; only its non-advancing continuation is
        // refused. Rows from both pages remain while Retry can ask the same
        // Account boundary again after it recovers.
        await expect(shell.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        await expect(shell.getByText('More linked Sessions could not be loaded.')).resolves.toBeDefined();

        await act(async () => {
            pressDetailButton('Retry');
        });
        await expect(shell.queryByText('More linked Sessions could not be loaded.')).resolves.toBeUndefined();
        expect(queryDetailButton('Load more')).toBeUndefined();
    });

    it('mounts the admitted source detail contribution', async () => {
        const shell = await mountShell();

        await openTheRow(shell);

        // The child rendered. Reaching it required the admitted handle from the
        // mount's own contribution snapshot AND a launch input the published
        // detail schema accepts; the host's projection refuses either way.
        await expect(shell.getByText(DETAIL_BODY_TEXT))
            .resolves.toEqual({ content: DETAIL_BODY_TEXT });
        // And not the other admitted source's, which is sorted ahead of it.
        await expect(shell.queryByText(OTHER_DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });

    it('keeps the linked-Session pages the reader loaded when the same entry rereads after a real refresh', async () => {
        const shell = await mountShell({ linkedSessionCount: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1, activeSurface: true });
        await openTheRow(shell);
        await act(async () => {
            pressDetailButton('Load more');
        });
        await expect(shell.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');

        harness.publishNewerObservation();
        await act(async () => {
            await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
        });
        for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); });

        // The entry was re-read, so its first page is current again; the page the reader loaded after it is
        // still theirs, and still continues where it left off.
        await expect(shell.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        expect(queryDetailButton('Load more')).toBeUndefined();
    });

    it('keeps the ready source detail mounted while the same entry rereads', async () => {
        const shell = await mountShell();
        await openTheRow(shell);
        const mountedBody = detailBodyNode();
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        const releaseDetailRead = harness.blockNextDetailRead();
        harness.publishNewerObservation();

        await act(async () => {
            await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
        });
        await act(async () => { await Promise.resolve(); });

        // A background reread may update the mounted input when it settles, but
        // it must not replace useful detail with a loading screen in between.
        const bodyWhilePending = queryDetailBodyNode();
        const loadingWhilePending = document.body.textContent?.includes('Reading this pull request') === true;

        releaseDetailRead();
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });
        expect(bodyWhilePending).toBe(mountedBody);
        expect(loadingWhilePending).toBe(false);
        expect(detailBodyNode()).toBe(mountedBody);
    });

    it('replaces the ready source detail while a different entry is being read', async () => {
        const shell = await mountShell();
        await measureFillRegion(900);
        await openTheRow(shell);
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        const releaseDetailRead = harness.blockNextDetailRead(LONG_ENTRY_ID);

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        await act(async () => { await Promise.resolve(); });

        // Ready detail is useful only for the exact entry and source instance
        // that produced it. Retaining it here would show the old provider body
        // beneath the newly selected entry's aggregate header.
        await expect(shell.getByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        expect(queryDetailBodyNode()).toBeNull();
        await expect(shell.getByRole('progressbar', { name: 'Reading this pull request' })).resolves.toBeDefined();

        releaseDetailRead();
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });
    });

    it('updates the host detail identity after a source mutation', async () => {
        const shell = await mountShell({ hostedDetail: true });
        await openTheRow(shell);
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');

        harness.publishNewerObservation();
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Complete source mutation' }));
        });
        await expect(shell.getByRole('heading', {
            name: 'Replace the duplicated normalizer after mutation',
        })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Close' })).resolves.toBeUndefined();
    });

    it('never renders A post-mutation state under deferred B and retires it before A is revisited', async () => {
        const shell = await mountShell({ hostedDetail: true });
        await openTheRow(shell);
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');

        harness.publishNewerObservation();
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Complete source mutation' }));
        });
        await expect(shell.getByRole('heading', {
            name: 'Replace the duplicated normalizer after mutation',
        })).resolves.toBeDefined();

        const releaseB = harness.blockNextDetailRead(LONG_ENTRY_ID);
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        await expect(shell.getByRole('heading', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        await expect(shell.queryByRole('heading', { name: 'Replace the duplicated normalizer after mutation' }))
            .resolves.toBeUndefined();
        await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer after mutation' }))
            .resolves.toBeDefined();
        await expect(shell.getByRole('progressbar', { name: 'Reading this pull request' })).resolves.toBeDefined();
        releaseB();
        await act(async () => { await Promise.resolve(); });

        const releaseA = harness.blockNextDetailRead('17');
        // The provider has returned to its original facts. Open the current retained
        // row; the fresh selection's exact read must publish the restored facts.
        harness.restoreSourceEntry();
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Replace the duplicated normalizer after mutation' }));
        });
        await expect(shell.getByRole('heading', { name: 'Replace the duplicated normalizer' }))
            .resolves.toBeDefined();
        await expect(shell.queryByText('Replace the duplicated normalizer after mutation'))
            .resolves.toBeUndefined();
        await expect(shell.getByRole('progressbar', { name: 'Reading this pull request' })).resolves.toBeDefined();
        releaseA();
        await act(async () => { await Promise.resolve(); });

        // A completion that started in the first A lifetime cannot become
        // current again merely because the reader later returns to the same
        // entry/source identity. The lifecycle generation, not only key
        // equality, makes this late answer inert.
        const releaseStaleA = harness.blockNextReobservation('17');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Complete source mutation' }));
            await Promise.resolve();
        });
        harness.restoreSourceEntry();
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
            await shell.press(await shell.getByRole('button', { name: 'Replace the duplicated normalizer' }));
        });
        releaseStaleA();
        await act(async () => {
            for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
        });
        await expect(shell.getByRole('heading', { name: 'Replace the duplicated normalizer' }))
            .resolves.toBeDefined();
        await expect(shell.queryByText('Replace the duplicated normalizer after mutation'))
            .resolves.toBeUndefined();
    });

    it('retires post-mutation state when the same local entry belongs to a different source', async () => {
        const shell = await mountShell({ otherSourceEntry: true, hostedDetail: true });
        await openTheRow(shell);
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');

        harness.publishNewerObservation();
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Complete source mutation' }));
        });
        const releaseOther = harness.blockNextDetailRead('17');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Another source matching entry' }));
        });

        await expect(shell.getByRole('heading', { name: 'Another source matching entry' }))
            .resolves.toBeDefined();
        // A's updated list row remains valid; its detail heading and body must retire.
        await expect(shell.getByRole('button', { name: 'Replace the duplicated normalizer after mutation' }))
            .resolves.toBeDefined();
        await expect(shell.queryByRole('heading', { name: 'Replace the duplicated normalizer after mutation' }))
            .resolves.toBeUndefined();
        expect(queryDetailBodyNode()).toBeNull();
        await expect(shell.getByRole('progressbar', { name: 'Reading this pull request' })).resolves.toBeDefined();
        releaseOther();
    });

    it.each([
        [404, 'github_not_found', false],
        [410, 'github_gone', true],
    ] as const)('settles restored alert HTTP %s through one exact read (%s; unresumable: %s)', async (_status, code, partialScan) => {
        const entryRef = { source: SOURCE, kindId: 'dependabot-alert', collisionScope: 'example/repository', entryId: '4' };
        const subPath = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: entryRef });
        const requestId = 'A89C:E6813:2EE25D2:4481C49:6AEB94CC';
        // The native GitHub get reports HTTP404/410 as unresolved, preserving
        // its bounded provider detail rather than asserting source absence.
        const detail = `GitHub request ID: ${requestId}`;
        const shell = await mountShell({ subPath, securityAlert: true, activeSurface: true,
            ...(partialScan ? { partialScan: true } : { deferLinkedEntry: true }),
            exactReadFailure: { class: 'unknown', code, detail } });
        expect(readTriageListWindowSnapshot(shell.context.hostApi, currentHarness!.ephemeralSharedScope).loadMore?.kind)
            .toBe(partialScan ? 'unresumable' : 'available');
        await vi.waitFor(() => { expect(currentHarness?.getEntryIds).toEqual(['4']); });
        await expect(shell.getByText('This entry could not be read from the source.')).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Details' })); });
        await expect(shell.getByText(code)).resolves.toBeDefined();
        await expect(shell.getByText(detail)).resolves.toBeDefined();
        await expect(shell.queryByText('No connection to open this through')).resolves.toBeUndefined();
        await expect(shell.queryByText('These details are not loaded')).resolves.toBeUndefined();
        expect(currentHarness?.exactReads).toHaveLength(1);
        expect(currentHarness?.readDetailInstanceIds).toEqual([]);
        expect(currentHarness?.continuedScanPages).toEqual([]);
        expect(lastPageLocation?.subPath ?? subPath).toEqual(subPath);
        // A context publication cannot retire the route or repeat the settled read.
        await act(async () => { await shell.updateSurface(surfaceContext({ securityAlert: true })); });
        expect(currentHarness?.getEntryIds).toEqual(['4']);
        expect(lastPageLocation?.subPath ?? subPath).toEqual(subPath);
        await expect(shell.getByText(detail)).resolves.toBeDefined();
    });

    it.each(['4', '1'])('retains a host-parsed restored alert %s after closing a previous detail', async (entryId) => {
        // The live AppShell decodes the host segment before publishing subPath.
        // Exercise that boundary rather than feeding the plugin its own builder output.
        const route = matchWorkspaceRoutePatterns(['plugins/[pluginId]/[localId]/[...subPath]'],
            `/plugins/happier.triage/triage/e,${SOURCE.pluginId},${SOURCE.localId},dependabot-alert,github%3A1424792902,${entryId}`);
        const subPath = route?.params.subPath;
        if (subPath === undefined) throw new Error('The host did not match the restored entry route');
        expect(subPath).toContain('github:1424792902');
        const code = 'github_gone';
        const detail = 'GitHub request ID: restored-route-request';
        const requestedLocations: string[] = [];
        const shell = await mountShell({ subPath, securityAlert: true, activeSurface: true, partialScan: true,
            onPageLocationRequest: location => { requestedLocations.push(location); },
            exactReadFailure: { class: 'unknown', code, detail } });
        await expect(shell.getByText('This entry could not be read from the source.')).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Back' })); });
        await act(async () => { await shell.updatePageLocation(''); });
        requestedLocations.length = 0;
        await act(async () => { await shell.updatePageLocation(subPath); });
        await expect(shell.getByText('This entry could not be read from the source.')).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Details' })); });
        await expect(shell.getByText(code)).resolves.toBeDefined();
        await expect(shell.getByText(detail)).resolves.toBeDefined();
        expect(requestedLocations).not.toContain('');
        expect(currentHarness?.continuedScanPages).toEqual([]);
    });

    it('keeps a warm restored alert pending until its exact read settles and preserves it on Refresh', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const requestedLocations: string[] = [];
        const alertPath = (entryId: string) => `e,${SOURCE.pluginId},${SOURCE.localId},dependabot-alert,example%2Frepository,${entryId}`;
        const shell = await mountShell({ subPath: alertPath('4'), securityAlert: true, activeSurface: true,
            partialScan: true, publishCurrentUiContext: context => { published = context; },
            onPageLocationRequest: location => { requestedLocations.push(location); } });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Back' })); });
        await act(async () => { await shell.updatePageLocation(''); });
        requestedLocations.length = 0;
        const release = currentHarness!.blockNextReobservation('1');
        await act(async () => { await shell.updatePageLocation(alertPath('1')); });
        await expect(shell.queryByText('This entry is outside the current filter')).resolves.toBeUndefined();
        expect(document.body.textContent).toContain('Reading this entry');
        await act(async () => { await refreshMountedShell(shell, published); });
        expect(requestedLocations).not.toContain('');
        await act(async () => { release(); });
        await expect(shell.getByRole('heading', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
        expect(currentHarness?.continuedScanPages).toEqual([]);
    });

    it('keeps a restored alert selected after an exact transport failure and Refresh retries that entry', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        const refused = new Set([TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1]);
        const subPath = `e,${SOURCE.pluginId},${SOURCE.localId},dependabot-alert,example%2Frepository,1`;
        const shell = await mountShell({ subPath, securityAlert: true, activeSurface: true, partialScan: true,
            hostedDetail: true, refusedHostReads: refused, publishCurrentUiContext: context => { published = context; } });
        await expect(shell.queryByText('This entry is outside the current filter')).resolves.toBeUndefined();
        expect(document.body.textContent).toContain('These details could not be read');
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Details' })); });
        await expect(shell.getByText('unavailable plugin_mounted_caller_unavailable')).resolves.toBeDefined();
        refused.clear();
        // The entry retry must not depend on a list refresh supplying a new row.
        refused.add(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1);
        await act(async () => { await refreshMountedShell(shell, published); });
        await expect(shell.getByRole('heading', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
        await expect(shell.queryByText('These details could not be read')).resolves.toBeUndefined();
        expect(lastPageLocation?.subPath ?? subPath).not.toBe('');
    });

    it('clears an unobservable routed entry while retaining its valid source facet', async () => {
        const filters = { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, sources: [{ source: SOURCE }] };
        const subPath = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            filters,
            selection: { source: { pluginId: 'qa.unconfigured', localId: 'source' },
                kindId: 'change', collisionScope: 'qa/absent', entryId: 'ghost' },
        });
        const hostTarget = { ready: false, pending: true, executionReady: false };
        const shell = await mountShell({ subPath, hostTarget, activeSurface: true, automaticDemandOnly: true });
        // Missing admission is still pending, not a settled noActiveInstance.
        expect(lastPageLocation).toBeNull();
        expect(currentHarness?.getEntryIds).toEqual([]);
        hostTarget.ready = true;
        await act(async () => { await shell.updateSurface(surfaceContext()); });
        await expect.poll(() => lastPageLocation?.subPath).toBe(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, filters,
        }));
        await expect(shell.queryByRole('group', { name: 'Details pane' })).resolves.toBeUndefined();
        expect(currentHarness?.getEntryIds).toEqual([]);
    });

    it('opens an unloaded restored link exactly and leaves further pages to visible Load more', async () => {
        const subPath = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection: {
                source: SOURCE,
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '17',
            },
        });
        const shell = await mountShell({ subPath, deferLinkedEntry: true, activeSurface: true });
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        expect(currentHarness?.continuedScanPages).toEqual([]);
        expect(currentHarness?.getEntryIds).toEqual(['17']);
        expect(currentHarness?.exactReads).toHaveLength(1);
        expect(currentHarness?.readDetailInstanceIds).toEqual([INSTANCE]);
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Back' }));
        });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });
        expect(currentHarness?.continuedScanPages).toHaveLength(1);
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.queryByText('These details are not loaded')).resolves.toBeUndefined();
    });

    it.each([
        ['', true], ['missing-entry-532', true], ['', false], ['missing-entry-532', false],
    ] as const)('opens an identity-only link through one exact source read (query: %s; explicit: %s)', async (query, explicitOpen) => {
        const subPath = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            query,
            selection: {
                source: SOURCE,
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '532',
            },
        });
        const shell = await mountShell({ subPath, explicitOpen, deferLinkedEntry: true, activeSurface: true,
            secondInstance: true });
        await act(async () => {
            await vi.waitFor(async () => {
                await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
            });
        });
        expect(currentHarness?.getEntryIds).toEqual(['532']);
        expect(currentHarness?.continuedScanPages).toEqual([]);
        expect(currentHarness?.exactReads).toEqual([{ v: 1, entryRef: { source: SOURCE, kindId: 'pull-request',
            collisionScope: 'example/repository', entryId: '532' }, sourceInstanceId: INSTANCE }]);
        expect(currentHarness?.readDetailInstanceIds).toEqual([INSTANCE]);
        await expect(shell.queryByText('These details are not loaded')).resolves.toBeUndefined();
    });

    it.each([true, false])('uses list-owned source availability for a fresh off-window link (explicit: %s)', async (explicitOpen) => {
        const subPath = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '710' } });
        const shell = await mountShell({ subPath, explicitOpen, deferSourceDescriptor: true, activeSurface: true, secondInstance: true });
        await act(async () => {
            await vi.waitFor(() => { expect(currentHarness?.getEntryIds).toEqual(['710']); });
        });
        expect(currentHarness?.getEntryIds).toEqual(['710']);
        expect(currentHarness?.continuedScanPages).toEqual([]);
        expect(currentHarness?.exactReads).toEqual([{ v: 1, entryRef: { source: SOURCE, kindId: 'pull-request',
            collisionScope: 'example/repository', entryId: '710' }, sourceInstanceId: INSTANCE }]);
        expect(currentHarness?.readDetailInstanceIds).toEqual([INSTANCE]);
        await expect(shell.queryByText('No connection to open this through')).resolves.toBeUndefined();
        await act(async () => { await shell.updateSurface(surfaceContext()); });
        await act(async () => {
            await vi.waitFor(async () => { await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined(); });
        });
        await expect(shell.queryByText('These details are not loaded')).resolves.toBeUndefined();
        await act(async () => { await shell.updateSurface({ ...surfaceContext(), textScale: 1.25 }); });
        expect(currentHarness?.getEntryIds).toEqual(['710']);
        expect(currentHarness?.readDetailInstanceIds).toEqual([INSTANCE]);
    });

    it.each([false, true])('opens an unloaded identity when the host publishes before acknowledging (pinned: %s)', async (pinned) => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        let requested!: (subPath: string) => void;
        const request = new Promise<string>(resolve => { requested = resolve; });
        let acknowledge!: () => void;
        const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
        const routes: string[] = [];
        const shell = await mountShell({ activeSurface: true, secondInstance: true, tabbedDetail: true,
            ...(pinned ? { pinnedEntryIds: ['532'] } : {}),
            replacePageLocation: async ({ subPath }) => {
                routes.push(subPath);
                if (routes.length === 1) { requested(subPath); await acknowledgement; }
                return subPath;
            },
            publishCurrentUiContext: context => { published = context; } });
        const command = (published as PluginUiContextEnrichmentV1 | null)?.commands?.find(entry => entry.title === 'Switch to Board');
        if (command?.command.kind !== 'executeAction') throw new Error('Expected the mounted Action');
        const address = TriageMountedUiInputV1Schema.parse(command.command.input);
        const declaration = PluginActionContributionV2Schema.parse(
            PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === 'ui/mounted-v1'));
        if (declaration.execution.target !== 'client') throw new Error('Missing mounted client Action');
        const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
            target: { ...declaration.execution.client, platform: 'web' }, activate: activateMountedUi });
        try {
            const handler = client.registration('actions', declaration.id);
            if (!handler) throw new Error('Mounted client Action did not activate');
            let result!: Promise<unknown>;
            await act(async () => {
                result = Promise.resolve(handler({ mountId: address.mountId,
                    operation: { kind: 'openDetail', entryRef: { source: SOURCE, kindId: 'pull-request',
                        collisionScope: 'example/repository', entryId: '532' } } }, {
                    plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                    contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
                    invocationSurface: 'agent', signal: new AbortController().signal,
                    ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
                }));
            });
            const subPath = await request;
            await act(async () => { await shell.updatePageLocation(subPath); });
            await act(async () => { acknowledge(); await result; });
            expect(await result).toEqual({ status: 'applied' });
            expect(routes).toEqual([subPath]);
            await act(async () => {
                await vi.waitFor(async () => { await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined(); });
            });
            await act(async () => {
                expect(await handler({ mountId: address.mountId, operation: { kind: 'selectDetailTab', tab: 'overview' } }, {
                    plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                    contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
                    invocationSurface: 'agent', signal: new AbortController().signal,
                    ui: clientActionUi(shell), ephemeralSharedScope: currentHarness!.ephemeralSharedScope,
                })).toEqual({ status: 'applied' });
            });
        } finally { await client.dispose(); }
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        expect(currentHarness?.getEntryIds).toEqual(['532']);
        expect(currentHarness?.exactReads).toHaveLength(1);
        expect(currentHarness?.readDetailInstanceIds).toEqual([INSTANCE]);
    });

    it.each([true, false])('shows source absence after one exact read of an identity-only link (explicit: %s)', async (explicitOpen) => {
        const subPath = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '532' } });
        const shell = await mountShell({ subPath, explicitOpen, absentEntryIds: ['532'], activeSurface: true });
        await act(async () => {
            await vi.waitFor(async () => {
                await expect(shell.getByText('This entry is no longer at the source.')).resolves.toBeDefined();
            });
        });
        expect(currentHarness?.getEntryIds).toEqual(['532']);
        expect(currentHarness?.exactReads).toHaveLength(1);
        expect(currentHarness?.readDetailInstanceIds).toEqual([]);
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.queryByText('No connection to open this through')).resolves.toBeUndefined();
    });

    it('presents an exact revoked task refusal without blaming its available connection', async () => {
        const subPath = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '532' } });
        const shell = await mountShell({ subPath, explicitOpen: true, revokedEntryIds: ['532'], activeSurface: true });
        await vi.waitFor(async () => {
            await expect(shell.getByText('This task isn’t shared with you anymore')).resolves.toBeDefined();
        });
        await expect(shell.queryByText('No connection to open this through')).resolves.toBeUndefined();
        expect(currentHarness?.getEntryIds).toEqual(['532']);
        expect(currentHarness?.exactReads).toHaveLength(1);
        expect(currentHarness?.readDetailInstanceIds).toEqual([]);
    });

    it('keeps an explicit exact open independent of the remaining list continuation', async () => {
        const subPath = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection: {
                source: SOURCE,
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '17',
            },
        });
        const shell = await mountShell({ subPath, explicitOpen: true, deferLinkedEntry: true, activeSurface: true });
        await act(async () => {
            await vi.waitFor(async () => {
                await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
            });
        });
        await expect(shell.queryByText('These details are not loaded')).resolves.toBeUndefined();
        expect(currentHarness?.continuedScanPages).toEqual([]);
        expect(currentHarness?.getEntryIds).toEqual(['17']);
    });

    it('keeps one source detail mount while the open shell crosses split and stacked layouts', async () => {
        let published: PluginUiContextEnrichmentV1 | null = null;
        let aggregateReads = 0;
        const shell = await mountShell({ activeSurface: true, secondInstance: true,
            onAggregateRead: () => { aggregateReads += 1; },
            publishCurrentUiContext: context => { published = context; } });
        await measureFillRegion(900);
        await openTheRow(shell);
        const readLens = () => {
            for (const entry of (published as PluginUiContextEnrichmentV1 | null)?.commands ?? []) {
                if (entry.command.kind !== 'executeAction') continue;
                const parsed = TriageMountedUiInputV1Schema.safeParse(entry.command.input);
                if (parsed.success && parsed.data.operation.kind === 'setLens'
                    && parsed.data.operation.filters.tasks === undefined) return parsed.data;
            }
            throw new Error('The shell published no PRs & Issues lens');
        };
        const address = readLens();
        if (address.operation.kind !== 'setLens') throw new Error('Expected a lens operation');
        const filters = { ...address.operation.filters, sources: [{ source: SOURCE, sourceInstanceId: INSTANCE }] };
        await act(async () => {
            expect(await shell.context.hostApi.executeAction('ui/mounted-v1', {
                mountId: address.mountId, operation: { ...address.operation, filters },
            })).toEqual({ status: 'applied' });
        });
        const mountedBody = detailBodyNode();
        const readsBeforeResize = aggregateReads;

        for (const width of [1280, 1920, 390, 1440]) {
            await measureFillRegion(width);
            const lens = readLens();
            expect(lens.operation).toMatchObject({ kind: 'setLens', filters });
            expect(lens.mountId).toBe(address.mountId);
            expect(detailBodyNode()).toBe(mountedBody);
        }

        // Responsive composition changes the detail container's layout, not
        // the detail's parent identity. Tabs, scroll and parser state therefore
        // remain owned by the same mounted source subtree.
        expect(detailBodyNode()).toBe(mountedBody);
        expect(aggregateReads).toBe(readsBeforeResize);
    });

    it('renders the aggregate-owned header beside it', async () => {
        const shell = await mountShell();

        await openTheRow(shell);

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        // Where it lives and when it was opened are one context line, not independently labelled header fields;
        // the source mark and the kind glyph say the source and the state, and one connection is not named.
        await expect(shell.getByText(`example/repository #17 · ${openedFixtureEntry()}`))
            .resolves.toBeDefined();
    });

    it('returns to the list when the detail is closed', async () => {
        const shell = await mountShell();

        await openTheRow(shell);
        // Pushed (no pane beside the page): the platform's Back is the detail's one way back.
        await act(async () => { focusButton('Back'); });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Back' }));
        });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        expect(activeElementName()).toContain('Replace the duplicated normalizer');
    });

    it('clears the stacked selection once when the host settles the declared Back step', async () => {
        // `core/SURFACE.md` §3.3 precedence 3. The host consumes ONE system
        // Back with the step this page declared, and the only thing that
        // reaches a mounted surface is a new location — so a shell that read
        // its location once, at construction, left the reader on a detail
        // screen the system Back button appeared to do nothing to.
        const shell = await mountShell();
        await openTheRow(shell);
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();

        const declared = lastPageLocation;
        if (declared === null) throw new Error('the shell declared no page location for its selection');
        const backLocation = declared.backLocation;
        // A selection-free step, declared with the selection and not before it.
        expect(backLocation).toBeDefined();
        expect(backLocation).not.toBe(declared.subPath);

        // The location the shell itself asked for, settled and delivered back.
        // It must NOT close anything: the reader is looking at the entry it
        // names, and a rule that fired here would slam the detail shut on the
        // render after every press.
        await act(async () => { await shell.updatePageLocation(declared.subPath); });
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        await act(async () => { focusButton('Back'); });

        // Now the host walks the declared step. The location names no entry.
        await act(async () => { await shell.updatePageLocation(backLocation as string); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.getByRole('button', {
            name: 'Replace the duplicated normalizer',
        })).resolves.toBeDefined();
        expect(activeElementName()).toContain('Replace the duplicated normalizer');
    });

    it.each([false, true])('re-observes a selected entry excluded by a partial window before deciding absence (absent: %s)', async (absent) => {
        const absentEntryIds: string[] = [];
        const shell = await mountShell({ absentEntryIds });
        await openTheRow(shell);
        await act(async () => { await shell.updatePageLocation(lastPageLocation!.subPath); });
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        expect(harness.getEntryIds).toEqual(['17']);
        const release = harness.blockNextReobservation('17');
        if (absent) absentEntryIds.push('17');
        harness.deferLinkedEntry.current = true;
        try {
            await act(async () => {
                await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
            });
            const snapshot = readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope);
            expect(snapshot.window?.rows.some(row => row.entryRef.entryId === '17')).toBe(false);
            expect(snapshot.window?.lanes.find(lane => lane.sourceInstanceId === INSTANCE)?.health)
                .toEqual({ kind: 'partial', reason: 'more-pages' });
            await vi.waitFor(() => { expect(harness.exactReads).toHaveLength(2); });
            // An incomplete list cannot settle the exact entry's existence.
            await expect(shell.queryByText('This entry is no longer in the list')).resolves.toBeUndefined();
            await expect(shell.queryByText('This entry is no longer at the source.')).resolves.toBeUndefined();
        } finally {
            await act(async () => { release(); });
        }
        await vi.waitFor(async () => {
            if (absent) await expect(shell.getByText('This entry is no longer at the source.')).resolves.toBeDefined();
            else await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        });
        expect(harness.getEntryIds).toEqual(['17', '17']);
        expect(harness.exactReads.map(read => read.sourceInstanceId)).toEqual([INSTANCE, INSTANCE]);
        expect(harness.continuedScanPages).toEqual([]);
    });

    it('refuses a selection whose route would not fit instead of dropping it silently', async () => {
        // `core/SURFACE.md` §3.2. The 1,024-byte bound is real and fails closed
        // in transport, but the page used to discard that refusal: the reducer
        // had already opened the entry, so the reader ended up on a detail
        // screen their URL did not name — unshareable, unreloadable, and
        // silent about it. The preflight moves the refusal in front of the
        // reducer, where it can still be shown and still preserves the lens.
        const selection = TriageEntryRefV1Schema.parse({
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: LONG_SCOPE,
            entryId: LONG_ENTRY_ID,
        });
        const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
        const selectionSegmentBytes = bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection,
        })) - bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection: null,
        }));
        // The padding is the settled query, and the query now REACHES the
        // window (`core/SURFACE.md` §6) — so it is a run the target row's own
        // summary contains. A run nothing matched would empty the list, and the
        // press this case is about would have nothing to press.
        const query = SUMMARY_PADDING.slice(
            0,
            PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 - selectionSegmentBytes - 1,
        );
        const openedAt = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query, selection: null,
        });
        // The page's own location is legal; only ADDING the selection is not.
        expect(bytes(openedAt)).toBeLessThanOrEqual(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);
        expect(bytes(openedAt) + selectionSegmentBytes)
            .toBeGreaterThan(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);

        const shell = await mountShell({ subPath: openedAt });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.getByText('That entry could not be opened')).resolves.toBeDefined();
        // The prior effective lens survives: the row is still listed under the
        // same query the page was opened at.
        await expect(shell.getByRole('button', { name: LONG_REF_ROW_TITLE }))
            .resolves.toBeDefined();
        // And the host was never asked, so no location moved either.
        expect(lastPageLocation).toBeNull();
    });

    it('opens the entry a Composer launch named, over the route the page was mounted at', async () => {
        // `core/SURFACE.md` §3.2's deciding direct-launch case, and `core/COMPOSER.md`
        // §7's assignment of it to `ui/surface.tsx`. **View details** produces a
        // complete strict launch input and the host carries it unchanged, so a
        // surface that forwards only `subPath` reports `{ kind: 'opened' }` and
        // silently drops the reader on the page's own prior location.
        //
        // The mounted route names A and the launch names B, so an entry read
        // from the route cannot pass for one read from the launch.
        const entryA = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: LONG_SCOPE,
            entryId: LONG_ENTRY_ID,
        } as const;
        const entryB = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        const shell = await mountShell({
            subPath: buildTriageRouteSubPathV1({
                ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                selection: entryA,
            }),
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entryB,
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            }) as unknown as JsonValue,
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        // B is what the reader is looking at, not the route's A.
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await expect(shell.queryByText(LONG_REF_ROW_TITLE)).resolves.toBeUndefined();

        // And acceptance is not complete at the reducer: the same location
        // writer every other selection uses was asked to replace the page
        // location, so the URL names B rather than the A it was opened at.
        const settled = lastPageLocation;
        if (settled === null) throw new Error('the launch selection wrote no page location');
        expect(settled.subPath).toBe(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection: entryB,
        }));

        // The launch is consumed once. A mount that re-read it on every render
        // would reopen the detail the host's own Back step just closed.
        const backLocation = settled.backLocation;
        expect(backLocation).toBeDefined();
        await act(async () => { await shell.updatePageLocation(backLocation as string); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.getByRole('button', {
            name: 'Replace the duplicated normalizer',
        })).resolves.toBeDefined();
    });

    it.each([false, true])('adopts a replacement launch on the same mounted page (Composer origin: %s)', async (composerOrigin) => {
        const entryA = { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' };
        const entryB = { source: SOURCE, kindId: 'pull-request', collisionScope: LONG_SCOPE, entryId: LONG_ENTRY_ID };
        // Delivered launch input is a host boundary fact, replaced without
        // changing the semantic mount or its host API.
        const deliveredLaunch = { current: buildTriageEntryDetailLaunchInput({
            entryRef: entryA,
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
        }) as unknown as JsonValue | undefined };
        const shell = await mountShell({ deliveredLaunch });
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        // The host retires a consumed handoff when its location settles.
        deliveredLaunch.current = undefined;
        await act(async () => { await shell.updatePageLocation(lastPageLocation!.subPath); });

        deliveredLaunch.current = buildTriageEntryDetailLaunchInput({
            entryRef: entryB,
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            ...(composerOrigin ? { originComposer: { kind: 'newSession' as const, instanceId: '44444444-4444-4444-8444-444444444444' } } : {}),
        }) as unknown as JsonValue;
        await act(async () => { await shell.updatePageLocation(''); });
        await expect(shell.getByText(LONG_REF_ROW_TITLE)).resolves.toBeDefined();
        await expect(shell.queryByText('Replace the duplicated normalizer')).resolves.toBeUndefined();
        expect(lastPageLocation?.subPath).toBe(buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: entryB }));
    });

    it('never substitutes the window connection for a launched connection whose full observation is absent', async () => {
        // The authority half of the same rule `openEntryDetails` enforces on the
        // way out: a launch names ONE exact connection, and the page that
        // receives it must act under that one. The window makes its own
        // qualification for every row it lists, and for an entry two of the
        // reader's accounts both observe, that answer is the deterministic tie
        // break — never the account the reader actually pressed **View details**
        // on. Adopting a launch by entry identity alone therefore opens somebody
        // else's connection while the page looks exactly right.
        const entry = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        const shell = await mountShell({
            secondInstance: true,
            // The second connection is configured and therefore nameable, but
            // this pass did not observe the entry through it. Only the first
            // connection has a full observation the detail contract may admit.
            secondInstanceObservesEntry: false,
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entry,
                sourceInstance: { source: SOURCE, sourceInstanceId: SECOND_INSTANCE },
            }) as unknown as JsonValue,
        });
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        await act(async () => {
            await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        // This page can name the launched connection from configured-source
        // facts, but it must not hand the first connection's observation to
        // the second connection's detail renderer.
        const configured = readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope).configuredSources;
        const secondLabel = configured.find(source => source.sourceInstanceId === SECOND_INSTANCE)?.displayLabel;
        const firstLabel = configured.find(source => source.sourceInstanceId === INSTANCE)?.displayLabel;
        expect(secondLabel).toContain('Second account');
        expect(firstLabel).toContain('Example account');
        await expect(shell.getByText(`example/repository #17 · ${openedFixtureEntry()} · via ${secondLabel}`))
            .resolves.toBeDefined();
        await expect(shell.getByText('No connection to open this through')).resolves.toBeDefined();
        expect(harness.readDetailInstanceIds).toEqual([]);
        // The header and refusal both stay on the launched connection; neither
        // silently falls through to the window's qualified account.
        await expect(shell.queryByText(`example/repository #17 · ${openedFixtureEntry()} · via ${firstLabel}`))
            .resolves.toBeUndefined();
    });

    it('falls through to the page location when the launch input is not admitted', async () => {
        // `openEntryDetails` admits the input through the SAME parser before it
        // navigates, so an inadmissible one only reaches here from something
        // else entirely. It is not a different page: the reader lands on the
        // location the host routed them to, which is what an ordinary open is.
        // The refused input names an entry that exists, under a connection to
        // ANOTHER source — the parser's `sourceMismatch` — so a surface that
        // forwarded it unvalidated would open the wrong entry rather than
        // crash, and would still pass a shallower assertion.
        const entryB = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        const shell = await mountShell({
            subPath: buildTriageRouteSubPathV1({
                ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                selection: entryB,
            }),
            launchInput: {
                v: 1,
                kind: 'entryDetail',
                entryRef: {
                    source: SOURCE,
                    kindId: 'pull-request',
                    collisionScope: LONG_SCOPE,
                    entryId: LONG_ENTRY_ID,
                },
                sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: INSTANCE },
            },
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await expect(shell.queryByText(LONG_REF_ROW_TITLE)).resolves.toBeUndefined();
    });

    it('refuses a Composer launch whose route would not fit, exactly as pressing that row is refused', async () => {
        // `core/SURFACE.md` §3.2 has ONE preflight site for row activation, and
        // `applyLensEdit` is it. The adoption used to dispatch `rowActivated`
        // raw, so a launch onto a page whose lens is already near the subpath
        // byte cap opened the detail with no location write and no refusal —
        // while pressing that same row on that same page WAS refused. Two
        // producers of one selection cannot disagree about whether it is legal.
        const entry = TriageEntryRefV1Schema.parse({
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: LONG_SCOPE,
            entryId: LONG_ENTRY_ID,
        });
        const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
        const selectionSegmentBytes = bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection: entry,
        })) - bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection: null,
        }));
        const query = SUMMARY_PADDING.slice(
            0,
            PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 - selectionSegmentBytes - 1,
        );
        const openedAt = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query, selection: null,
        });
        // The page's own location is legal; only ADDING the launched selection
        // to it is not.
        expect(bytes(openedAt)).toBeLessThanOrEqual(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);
        expect(bytes(openedAt) + selectionSegmentBytes)
            .toBeGreaterThan(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);

        const shell = await mountShell({
            subPath: openedAt,
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entry,
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            }) as unknown as JsonValue,
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('That entry could not be opened')).resolves.toBeDefined();
        // Nothing opened, so there is no detail region and no Close beside it.
        await expect(shell.queryByText('Close')).resolves.toBeUndefined();
        // The prior effective lens survives: the row is still listed under the
        // query the page was opened at.
        await expect(shell.getByRole('button', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        // And the host was never asked, so no location moved either.
        expect(lastPageLocation).toBeNull();
    });

    it('opens an explicitly launched entry the page lens excludes through its exact source read', async () => {
        // `core/SURFACE.md` §3.2 and `core/COMPOSER.md` §7: a ref the current
        // projection has not materialized STILL selects, and the header says so
        // rather than refusing. The adoption used to scan only the mounted
        // window — already filtered by the page's own lens — and fall off the
        // end with no else branch, so a launch onto a page carrying an ordinary
        // query produced no detail, no header, no location write and no message
        // at all, while the opener still reported `{ kind: 'opened' }`.
        const entryB = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        // An ordinary reader state, not a bounded window: a settled query the
        // OTHER row matches and the launched entry does not.
        const query = 'canonical';
        const openedAt = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query });
        const shell = await mountShell({
            hostedDetail: true,
            subPath: openedAt,
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entryB,
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            }) as unknown as JsonValue,
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        // Explicit launch and pin opens now share the one exact-read owner;
        // a filtered-out row is not evidence that the source lacks the entry.
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();
        expect(currentHarness?.getEntryIds).toEqual(['17']);
        expect(currentHarness?.readDetailInstanceIds).toEqual([INSTANCE]);
        await expect(shell.getByRole('group', { name: 'Details pane' })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Close' })).resolves.toBeUndefined();
        await expect(shell.queryByText('This entry is no longer in the list')).resolves.toBeUndefined();

        // Acceptance is not complete at the reducer: the one route owner wrote
        // the result, so a copied link, reload and Back name the launched entry.
        const settled = lastPageLocation;
        if (settled === null) throw new Error('the launch selection wrote no page location');
        expect(settled.subPath).toBe(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query, selection: entryB,
        }));

        // Closing returns to the list the page's lens really does produce: the
        // other row is listed and the launched entry is not. That exclusion is
        // what made the old fall-through silent.
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Close details' }));
        });
        await expect(shell.getByRole('button', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', {
            name: 'Replace the duplicated normalizer',
        })).resolves.toBeUndefined();
    });

    it('says the source contributes no detail view rather than mounting nothing', async () => {
        const shell = await mountShell({ contributesDetail: false });

        await openTheRow(shell);

        await expect(shell.getByText('This source has no detail view')).resolves.toBeDefined();
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });
});
