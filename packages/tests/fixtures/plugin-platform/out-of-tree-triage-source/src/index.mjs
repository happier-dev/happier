/**
 * An out-of-tree Triage source, authored the way a third party has to author
 * one: only published Plugin SDK, Triage protocol and shared source-helper
 * entry points, arbitrary local Action ids,
 * and no knowledge of any first-party source.
 *
 * If this file needs a repository-internal import, a path alias, an ambient
 * declaration, or a Triage aggregate edit to work, the public source ABI is not
 * genuinely authorable and `qa/QA-PROTOCOL.md` QB-01 has failed.
 */
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageSourceConnectedAccountInputsV1,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import { decodeConfiguration, encodeConfiguration } from './configuration.mjs';
import {
    LEDGER_CONNECTION_FIELD_ID,
    LEDGER_CONNECTION_MODE_ID,
    ledgerConnectedAccountRuntime,
} from './connection.mjs';
import {
    LEDGER_DETAIL_DOCUMENT_CONTENT_TYPE,
    LEDGER_DETAIL_DOCUMENT_MAX_BYTES,
    LEDGER_DETAIL_DOCUMENT_RESOURCE_ID,
    LEDGER_DETAIL_STATIC_ROOT,
    ledgerDetailDocumentResource,
} from './detail.mjs';
import {
    LEDGER_SPACE_IDS,
    LEDGER_SPACE_ID_LIST,
    LEDGER_UNAVAILABLE_REF,
    readLedgerPage,
    readLedgerRow,
} from './ledger.mjs';
import { mapLedgerAuthoritativeRead, mapLedgerPage } from './map.mjs';
import {
    LEDGER_ACTION_IDS,
    LEDGER_ACCOUNT_PURPOSE,
    LEDGER_CONNECTED_ACCOUNT_ID,
    LEDGER_CONTRIBUTION_LOCAL_ID,
    LEDGER_DISPLAY_NAME,
    LEDGER_PLUGIN_ID,
    LEDGER_SETTINGS_PAGE_ID,
    LEDGER_SETTINGS_RENDERER_ID,
    LEDGER_SETTINGS_ARTIFACT_ID,
} from './identity.mjs';
export {
    LEDGER_ACTION_IDS,
    LEDGER_ACCOUNT_PURPOSE,
    LEDGER_CONNECTED_ACCOUNT_ID,
    LEDGER_CONTRIBUTION_LOCAL_ID,
} from './identity.mjs';

/**
 * The input leaf each account-bearing read carries its account in. Declaring it
 * is what lets the host resolve the exact credential before the Action runs;
 * `listInstances` has no binding because discovering accounts is what it does.
 */
const INSTANCE_ACCOUNT_BINDINGS = [{
    path: 'instance.binding.account',
    purpose: LEDGER_ACCOUNT_PURPOSE,
}];

const DETAIL_RENDERER_ID = 'ledger-detail';

/**
 * The invocation-local scan continuation.
 *
 * It binds the provider offset and the limit the caller submitted on the
 * initial page, which is what makes a mid-scan limit change unrepresentable. It
 * exists only inside one scan invocation: nothing writes it anywhere, and the
 * source keeps no map of outstanding walks.
 */
function encodeContinuation(offset, limit) {
    return { v: 1, token: `o=${offset};l=${limit}` };
}

function decodeContinuation(continuation) {
    const parsed = /^o=(\d+);l=(\d+)$/u.exec(continuation?.token ?? '');
    if (parsed === null) return null;
    return { offset: Number(parsed[1]), limit: Number(parsed[2]) };
}

function readPageRequest(input) {
    if (input.page.kind === 'initial') {
        // The protocol-owned input schema already admits only page sizes whose
        // encoded result fits the host Action boundary. Re-clamping here would
        // make this external source a second, stale cardinality owner.
        return { offset: 0, limit: input.page.limit };
    }
    return decodeContinuation(input.page.continuation);
}

/** Discovers the spaces this account can read. Discovery never configures. */
async function runListInstances(_input, context) {
    const listed = await context.services.connectedAccounts.listAccounts({
        purpose: LEDGER_ACCOUNT_PURPOSE,
    });
    const candidates = [];
    const failures = [];
    for (const listing of listed.accounts) {
        const binding = { purpose: LEDGER_ACCOUNT_PURPOSE, account: listing.account };
        // One candidate per space the account can read. Discovery offers the
        // choice and configures nothing: which space an instance reads is
        // settled by ordinary source configuration, so neither space is
        // preselected here and neither is reachable only through an
        // environment variable or a global mode.
        for (const space of LEDGER_SPACE_ID_LIST) {
            candidates.push({
                v: 1,
                binding,
                localInstanceKey: space,
                keyStability: 'stable',
                configuration: encodeConfiguration(space),
                locator: { v: 1, displayLabel: space },
            });
        }
    }
    // A truncated account listing is never reported as a complete enumeration.
    return listed.status === 'truncated'
        ? {
            kind: 'incomplete',
            candidates,
            failures,
            failure: {
                class: 'unsupportedContract',
                code: 'acme/account-listing-truncated',
            },
        }
        : { kind: 'complete', candidates, failures };
}

/** Walks one bounded provider page and maps it tolerantly. */
async function runScan(input) {
    const space = decodeConfiguration(input.instance.configuration);
    const request = readPageRequest(input);
    if (space === null || request === null) {
        return {
            kind: 'failed',
            failure: {
                class: 'unsupportedContract',
                code: 'acme/unreadable-source-token',
            },
        };
    }

    const { rows, nextOffset } = readLedgerPage(space, request.offset, request.limit);
    const { observations, omittedItemCount } = mapLedgerPage(rows, space);
    const evidence = omittedItemCount > 0
        ? { kind: 'partial', reason: 'acme/unmappable-rows', omittedItemCount }
        : { kind: 'walkFinished' };

    return nextOffset === null
        ? { kind: 'complete', observations, evidence }
        : {
            kind: 'page',
            observations,
            evidence,
            continuation: encodeContinuation(nextOffset, request.limit),
        };
}

/** Reads one exact entry authoritatively through the exact configured instance. */
async function runGet(input) {
    const space = decodeConfiguration(input.instance.configuration);
    if (space === null || space !== input.localRef.collisionScope) {
        return {
            kind: 'unresolved',
            localRef: input.localRef,
            failure: {
                class: 'unsupportedContract',
                code: 'acme/instance-scope-mismatch',
            },
        };
    }
    // The unreachable row belongs to the curated space. Claiming a transient
    // provider outage for it in the QA space would report an id that space
    // never had as "try again later" rather than as the absence it is.
    if (space === LEDGER_SPACE_IDS.curated && input.localRef.entryId === LEDGER_UNAVAILABLE_REF) {
        return {
            kind: 'unresolved',
            localRef: input.localRef,
            failure: {
                class: 'transient',
                code: 'acme/provider-unavailable',
                retryNotBeforeMs: 1_760_000_900_000,
            },
        };
    }
    return mapLedgerAuthoritativeRead(
        readLedgerRow(space, input.localRef.entryId),
        input.localRef,
        space,
    );
}

/**
 * Derives one Action declaration from its bound protocol role.
 *
 * Nothing about surface, danger level, or schema is retyped here: a source that
 * copied those literals would drift from the protocol without failing.
 */
function actionContract(role) {
    const declaration = sourceOperations[role].declaration;
    if (declaration.input.kind !== 'protocolDefined') {
        throw new TypeError('acme_ledger_expects_protocol_defined_input');
    }
    return {
        scopes: ['global'],
        surfaces: declaration.surfaces,
        execution: { target: 'daemon' },
        dangerLevel: declaration.dangerLevel,
        // This source declares only Connected Accounts. Its purpose binding
        // must name an account in every admitted input arm, so use the public
        // account-only specialization rather than the generic native union.
        inputSchema: TriageSourceConnectedAccountInputsV1[role].jsonSchema,
        resultSchema: declaration.resultSchema.jsonSchema,
    };
}

const sourceOperations = TriageSourcesContributionProtocolV1.operations;

const plugin = definePlugin({
    id: LEDGER_PLUGIN_ID,
    version: '1.0.0',
    displayName: LEDGER_DISPLAY_NAME,
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    hostAccess: {
        required: [{
            id: LEDGER_ACCOUNT_PURPOSE,
            capability: 'connectedAccounts',
            reason: 'List the Acme Ledger accounts already authorized for this source,'
                + ' and read the spaces each one carries.',
            scope: {
                serviceRefs: [LEDGER_CONNECTED_ACCOUNT_ID],
                // Discovery enumerates the accounts already bound to this
                // purpose; it opens no selection flow of its own. No
                // `materializationKinds`: the provider is in-process, so this
                // source never materializes a credential and the host
                // authorizes none.
                operations: ['use'],
            },
        }],
        optional: [],
    },
    connectedAccountDescriptors: {
        [LEDGER_CONNECTED_ACCOUNT_ID]: {
            declaration: {
                title: 'Acme Ledger (fixture)',
                description: 'A deterministic in-repository fixture connection.'
                    + ' It reaches no network and carries no real credential.',
                authentication: {
                    defaultModeId: LEDGER_CONNECTION_MODE_ID,
                    modes: [{
                        id: LEDGER_CONNECTION_MODE_ID,
                        kind: 'manual',
                        title: 'Acme Ledger fixture key',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: LEDGER_CONNECTION_FIELD_ID,
                            title: 'Fixture key',
                            description: 'The published Acme Ledger fixture key.'
                                + ' It authenticates nothing outside this fixture.',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                        // No connection-level configuration: the space an
                        // instance reads belongs to Triage source
                        // configuration, not to the account.
                    }],
                },
            },
            runtime: ledgerConnectedAccountRuntime,
        },
    },
    actions: {
        [LEDGER_ACTION_IDS.listInstances]: {
            title: 'Discover Acme Ledger spaces',
            ...actionContract('listInstances'),
            hostAccess: [LEDGER_ACCOUNT_PURPOSE],
            run: runListInstances,
        },
        [LEDGER_ACTION_IDS.scan]: {
            title: 'Walk one Acme Ledger space',
            ...actionContract('scan'),
            hostAccess: [LEDGER_ACCOUNT_PURPOSE],
            connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
            run: runScan,
        },
        [LEDGER_ACTION_IDS.get]: {
            title: 'Read one Acme Ledger entry',
            ...actionContract('get'),
            hostAccess: [LEDGER_ACCOUNT_PURPOSE],
            connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
            run: runGet,
        },
    },
    resources: {
        [LEDGER_DETAIL_DOCUMENT_RESOURCE_ID]: {
            source: 'dynamic',
            kind: 'config',
            contentType: LEDGER_DETAIL_DOCUMENT_CONTENT_TYPE,
            // `surface` is what makes this a detail body rather than a banner:
            // the host stamps the mount's own launch input onto every read, so
            // the producer learns which entry the reader selected.
            scope: 'surface',
            maxBytes: LEDGER_DETAIL_DOCUMENT_MAX_BYTES,
            runtime: ledgerDetailDocumentResource,
        },
    },
    ui: {
        renderers: [{
            id: DETAIL_RENDERER_ID,
            kind: 'declarative',
            // The static root is the first paint and the unavailable-document
            // state; it names no entry and no owner. The live document below is
            // the only thing that resolves either.
            root: LEDGER_DETAIL_STATIC_ROOT,
            documentSource: {
                kind: 'resource',
                resourceId: LEDGER_DETAIL_DOCUMENT_RESOURCE_ID,
            },
        }, {
            id: LEDGER_SETTINGS_RENDERER_ID,
            kind: 'reactNative',
            artifact: LEDGER_SETTINGS_ARTIFACT_ID,
            requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
        }],
        settingsGroups: [{
            id: 'ledger', title: LEDGER_DISPLAY_NAME, icon: 'settings', defaultRank: 40,
        }],
        settingsPages: [{
            id: LEDGER_SETTINGS_PAGE_ID,
            group: { kind: 'plugin', localId: 'ledger' },
            title: 'PRs & Issues',
            subtitle: 'Choose which Acme Ledger spaces appear in PRs & Issues.',
            keywords: ['ledger', 'changes', 'tickets'],
            icon: 'settings',
            defaultRank: 10,
            renderer: LEDGER_SETTINGS_RENDERER_ID,
        }],
    },
    contributesTo: {
        [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
            [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
                [LEDGER_CONTRIBUTION_LOCAL_ID]: TriageSourcesContributionProtocolV1.contribute({
                    descriptor: {
                        v: 1,
                        purpose: LEDGER_ACCOUNT_PURPOSE,
                        displayName: LEDGER_DISPLAY_NAME,
                        settingsPageId: LEDGER_SETTINGS_PAGE_ID,
                        kinds: [
                            {
                                id: 'change',
                                workflowSubject: 'pullRequest',
                                displayName: 'Change',
                                pluralDisplayName: 'Changes',
                            },
                            {
                                id: 'ticket',
                                workflowSubject: 'issue',
                                displayName: 'Ticket',
                                pluralDisplayName: 'Tickets',
                            },
                        ],
                    },
                    operations: {
                        listInstances: sourceOperations.listInstances
                            .bind(LEDGER_ACTION_IDS.listInstances),
                        scan: sourceOperations.scan.bind(LEDGER_ACTION_IDS.scan),
                        get: sourceOperations.get.bind(LEDGER_ACTION_IDS.get),
                    },
                    surfaces: { detail: { renderer: DETAIL_RENDERER_ID } },
                }),
            },
        },
    },
});

export const { manifest, activate } = plugin;
