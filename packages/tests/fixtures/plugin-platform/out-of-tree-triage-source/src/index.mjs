/**
 * An out-of-tree Triage source, authored the way a third party has to author
 * one: only the published `@happier-dev/plugin-sdk` and
 * `@happier-dev/triage-protocol/v1` entry points, arbitrary local Action ids,
 * and no knowledge of any first-party source.
 *
 * If this file needs a repository-internal import, a path alias, an ambient
 * declaration, or a Triage aggregate edit to work, the public source ABI is not
 * genuinely authorable and `qa/QA-PROTOCOL.md` QB-01 has failed.
 */
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
    MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import {
    LEDGER_UNAVAILABLE_REF,
    readLedgerDetailOnlyFacts,
    readLedgerPage,
    readLedgerRow,
} from './ledger.mjs';
import { mapLedgerAuthoritativeRead, mapLedgerPage } from './map.mjs';

/** Arbitrary source-local Action ids. The protocol never dictates them. */
export const LEDGER_ACTION_IDS = Object.freeze({
    listInstances: 'ledger/discover-spaces',
    scan: 'ledger/walk-space',
    get: 'ledger/read-entry',
});

export const LEDGER_CONTRIBUTION_LOCAL_ID = 'acme-ledger';
export const LEDGER_ACCOUNT_PURPOSE = 'acme.ledger.api';

const DETAIL_RENDERER_ID = 'ledger-detail';

/**
 * The source's own configured-instance token. It is a bounded, source-decoded
 * string: it carries the provider space this instance reads and nothing else —
 * no credential, no origin, no account ref.
 */
function encodeConfiguration(space) {
    return { v: 1, token: `space=${space}` };
}

function decodeConfiguration(configuration) {
    const token = configuration?.token;
    if (typeof token !== 'string' || !token.startsWith('space=')) return null;
    const space = token.slice('space='.length);
    return space.length > 0 ? space : null;
}

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
        return { offset: 0, limit: Math.min(input.page.limit, MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1) };
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
        candidates.push({
            v: 1,
            binding,
            localInstanceKey: 'acme/ledger',
            keyStability: 'stable',
            configuration: encodeConfiguration('acme/ledger'),
            locator: { v: 1, displayLabel: 'acme/ledger' },
        });
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

    const { rows, nextOffset } = readLedgerPage(request.offset, request.limit);
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
    if (input.localRef.entryId === LEDGER_UNAVAILABLE_REF) {
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
    return mapLedgerAuthoritativeRead(readLedgerRow(input.localRef.entryId), input.localRef, space);
}

/**
 * Resolves the facts this source loads only in its detail surface. The list
 * projection declares the fact exists; only this read produces its value.
 */
export function readDetailOnlyFacts(entryId) {
    return readLedgerDetailOnlyFacts(entryId);
}

/**
 * Derives one Action declaration from its bound protocol role.
 *
 * Nothing about surface, danger level, or schema is retyped here: a source that
 * copied those literals would drift from the protocol without failing.
 */
function actionContract(operation) {
    const declaration = operation.declaration;
    if (declaration.input.kind !== 'protocolDefined') {
        throw new TypeError('acme_ledger_expects_protocol_defined_input');
    }
    return {
        scopes: ['global'],
        surfaces: declaration.surfaces,
        execution: { target: 'daemon' },
        dangerLevel: declaration.dangerLevel,
        inputSchema: declaration.input.schema.jsonSchema,
        resultSchema: declaration.resultSchema.jsonSchema,
    };
}

const sourceOperations = TriageSourcesContributionProtocolV1.operations;

const plugin = definePlugin({
    id: 'acme.ledger',
    version: '1.0.0',
    displayName: 'Acme Ledger',
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    actions: {
        [LEDGER_ACTION_IDS.listInstances]: {
            title: 'Discover Acme Ledger spaces',
            ...actionContract(sourceOperations.listInstances),
            run: runListInstances,
        },
        [LEDGER_ACTION_IDS.scan]: {
            title: 'Walk one Acme Ledger space',
            ...actionContract(sourceOperations.scan),
            run: runScan,
        },
        [LEDGER_ACTION_IDS.get]: {
            title: 'Read one Acme Ledger entry',
            ...actionContract(sourceOperations.get),
            run: runGet,
        },
    },
    ui: {
        renderers: [{
            id: DETAIL_RENDERER_ID,
            kind: 'declarative',
            root: { kind: 'text', text: 'Acme Ledger entry' },
        }],
    },
    contributesTo: {
        [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
            [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
                [LEDGER_CONTRIBUTION_LOCAL_ID]: TriageSourcesContributionProtocolV1.contribute({
                    descriptor: {
                        v: 1,
                        purpose: LEDGER_ACCOUNT_PURPOSE,
                        displayName: 'Acme Ledger',
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
