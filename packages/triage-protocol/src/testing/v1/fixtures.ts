import {
    TriageSourceDescriptorV1Schema,
    type TriageSourceDescriptorV1,
} from '../../v1/descriptor.js';
import {
    TriageDetailSurfaceInputV1Schema,
    type TriageDetailSurfaceInputV1,
} from '../../v1/detail.js';
import {
    TriageConfiguredSourceInstanceV1Schema,
    TriageListInstancesInputV1Schema,
    TriageListInstancesResultV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageListInstancesInputV1,
    type TriageListInstancesResultV1,
} from '../../v1/instances.js';
import {
    TriageGetInputV1Schema,
    TriageGetResultV1Schema,
    TriageScanInputV1Schema,
    TriageScanResultV1Schema,
    type TriageGetInputV1,
    type TriageGetResultV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
} from '../../v1/operations.js';
import {
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
    type TriageSourceAdministrationActionInputV1,
    type TriageSourceAdministrationActionResultV1,
} from '../../v1/sourceAdministration.js';
import {
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1Schema,
    type TriagePrepareReviewWorkspaceInputV1,
    type TriagePrepareReviewWorkspaceResultV1,
} from '../../v1/workspace.js';

/** The complete set of valid public V1 values one source vertical exchanges. */
export type TriageSourceV1Fixture = Readonly<{
    descriptor: TriageSourceDescriptorV1;
    configuredInstance: TriageConfiguredSourceInstanceV1;
    listInstancesInput: TriageListInstancesInputV1;
    listInstancesResult: TriageListInstancesResultV1;
    scanInput: TriageScanInputV1;
    scanResult: TriageScanResultV1;
    getInput: TriageGetInputV1;
    getResult: TriageGetResultV1;
    prepareReviewWorkspaceInput: TriagePrepareReviewWorkspaceInputV1;
    prepareReviewWorkspaceResult: TriagePrepareReviewWorkspaceResultV1;
    administrationInput: TriageSourceAdministrationActionInputV1;
    administrationResult: TriageSourceAdministrationActionResultV1;
    detailInput: TriageDetailSurfaceInputV1;
}>;

const SOURCE_CONTRIBUTION = Object.freeze({
    pluginId: 'happier.example.source',
    localId: 'example-forge',
});
const SOURCE_INSTANCE_ID = '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05';
const ACCOUNT_PURPOSE = 'example.api';
const ACCOUNT_REF = Object.freeze({
    service: Object.freeze({ pluginId: 'happier.example.source', localId: 'example-account' }),
    accountId: 'account-1',
});
const LOCAL_REF = Object.freeze({
    kindId: 'pull-request',
    collisionScope: 'example:41231',
    entryId: '17',
});
const ENTRY_REF = Object.freeze({ source: SOURCE_CONTRIBUTION, ...LOCAL_REF });
const DRAFT = Object.freeze({
    v: 1,
    binding: Object.freeze({ purpose: ACCOUNT_PURPOSE, account: ACCOUNT_REF }),
    localInstanceKey: 'example:41231',
    keyStability: 'stable',
    configuration: Object.freeze({ v: 1, token: 'example-configuration-token-v1' }),
    locator: Object.freeze({ v: 1, displayLabel: 'example/repository' }),
});
const CONFIGURED_INSTANCE = Object.freeze({
    v: 1,
    instance: Object.freeze({
        source: SOURCE_CONTRIBUTION,
        sourceInstanceId: SOURCE_INSTANCE_ID,
    }),
    binding: DRAFT.binding,
    localInstanceKey: DRAFT.localInstanceKey,
    configuration: DRAFT.configuration,
    locator: DRAFT.locator,
});
const PRESENT_OBSERVATION = Object.freeze({
    kind: 'present',
    localRef: LOCAL_REF,
    locator: Object.freeze({
        v: 1,
        webUrl: 'https://example.test/example/repository/pull/17',
        displayPath: 'example/repository #17',
        // Source-private bytes: the target copies them onto the next `get` and
        // never parses them (`CONTRACT.md` §5, §6).
        routingToken: 'example-route-token-v1',
    }),
    snapshot: Object.freeze({
        v: 1,
        title: 'Replace the duplicated normalizer',
        summary: 'Consolidates two competing owners into the canonical one.',
        scopeLabel: 'example/repository',
        createdAtMs: 1_760_000_000_000,
        state: Object.freeze({ presentation: 'active', nativeLabel: 'Open' }),
        facts: Object.freeze([
            Object.freeze({
                id: 'example/number',
                importance: 'primary',
                value: Object.freeze({ kind: 'text', value: '#17' }),
            }),
            Object.freeze({
                id: 'example/checks',
                importance: 'primary',
                value: Object.freeze({ kind: 'status', value: 'All passing', tone: 'success' }),
            }),
            Object.freeze({
                id: 'example/last-release',
                importance: 'supplementary',
                value: Object.freeze({ kind: 'detailOnly' }),
            }),
        ]),
    }),
    viewer: Object.freeze({
        involvement: Object.freeze(['reviewRequested']),
        sourceAttention: Object.freeze({
            level: 'required',
            reasonId: 'example/review-requested',
            reasonLabel: 'Your review is requested',
        }),
    }),
    sourceUpdatedAtMs: 1_760_000_600_000,
    nativeRevision: 'b3f1c0a9d2e4',
});

/**
 * Creates the valid, non-durable public V1 values a source vertical exchanges.
 *
 * Every value is produced by parsing through its own published schema, so a
 * fixture that drifts from the contract fails at construction rather than
 * silently teaching consumers an invalid shape. Provider execution, credential
 * materialization, and target persistence stay outside this test-only helper.
 *
 * `detailInput` carries no Composer-origin field, because the envelope has
 * none: the `originComposer` address travels in exactly one carrier, Triage's
 * own closed private launch input (PEP `03d1` §17.8), and never crosses this
 * source-facing protocol. There is therefore no `composerOriginDetailInput`
 * variant to build here; the executable admission of every host arm is covered
 * where the field lives, at
 * `packages/plugins/triage/src/composer/entryDetailLaunchInput.test.ts`.
 */
export function createTriageSourceV1Fixture(): TriageSourceV1Fixture {
    return Object.freeze({
        descriptor: TriageSourceDescriptorV1Schema.parse({
            v: 1,
            purpose: ACCOUNT_PURPOSE,
            displayName: 'Example forge',
            kinds: [
                {
                    id: 'pull-request',
                    workflowSubject: 'pullRequest',
                    displayName: 'Pull request',
                    pluralDisplayName: 'Pull requests',
                },
                { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
            ],
        }),
        configuredInstance: TriageConfiguredSourceInstanceV1Schema.parse(CONFIGURED_INSTANCE),
        listInstancesInput: TriageListInstancesInputV1Schema.parse({ v: 1 }),
        listInstancesResult: TriageListInstancesResultV1Schema.parse({
            kind: 'complete',
            candidates: [DRAFT],
            failures: [],
        }),
        scanInput: TriageScanInputV1Schema.parse({
            v: 1,
            instance: CONFIGURED_INSTANCE,
            page: { kind: 'initial', limit: 32 },
        }),
        scanResult: TriageScanResultV1Schema.parse({
            kind: 'complete',
            observations: [PRESENT_OBSERVATION],
            evidence: { kind: 'walkFinished' },
        }),
        // The locator arm is populated deliberately: an account-wide scan
        // discovers entries across many provider scopes, so `get` carries the
        // newest observed locator back and the source stays the only parser of
        // its own routing token (`CONTRACT.md` §5).
        getInput: TriageGetInputV1Schema.parse({
            v: 1,
            instance: CONFIGURED_INSTANCE,
            localRef: LOCAL_REF,
            lastKnownLocator: PRESENT_OBSERVATION.locator,
        }),
        getResult: TriageGetResultV1Schema.parse(PRESENT_OBSERVATION),
        prepareReviewWorkspaceInput: TriagePrepareReviewWorkspaceInputV1Schema.parse({
            v: 1,
            instance: CONFIGURED_INSTANCE,
            entryRef: ENTRY_REF,
            observed: {
                baseSha: 'a1b2c3d4e5f6',
                headSha: 'b3f1c0a9d2e4',
                nativeRevision: 'b3f1c0a9d2e4',
                observedAtMs: 1_760_000_600_000,
            },
            workspace: {
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/workspaces/example-repository',
            },
        }),
        prepareReviewWorkspaceResult: TriagePrepareReviewWorkspaceResultV1Schema.parse({
            kind: 'prepared',
            repositoryPath: '/workspaces/example-repository',
            branch: 'review/pull-17',
            created: true,
            currentness: { kind: 'currentAtObservedHead' },
        }),
        administrationInput: TriageSourceAdministrationActionInputV1Schema.parse({
            v: 1,
            kind: 'create',
            draft: DRAFT,
        }),
        administrationResult: TriageSourceAdministrationActionResultV1Schema.parse({
            kind: 'active',
            sourceInstanceId: SOURCE_INSTANCE_ID,
        }),
        detailInput: TriageDetailSurfaceInputV1Schema.parse({
            v: 1,
            instance: CONFIGURED_INSTANCE,
            observation: {
                entryRef: ENTRY_REF,
                observedAtMs: 1_760_000_700_000,
                locator: PRESENT_OBSERVATION.locator,
                snapshot: PRESENT_OBSERVATION.snapshot,
                viewer: PRESENT_OBSERVATION.viewer,
                sourceUpdatedAtMs: PRESENT_OBSERVATION.sourceUpdatedAtMs,
                nativeRevision: PRESENT_OBSERVATION.nativeRevision,
            },
            linkedSessions: [{ sessionId: 'session-1', displayTitle: 'Review pull 17' }],
        }),
    });
}
