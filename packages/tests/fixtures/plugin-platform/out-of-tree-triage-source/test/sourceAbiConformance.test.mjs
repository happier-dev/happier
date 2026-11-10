import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
/**
 * `qa/QA-PROTOCOL.md` §2.1 as runnable cases.
 *
 * Every case here is decidable today: its named prerequisite is the published
 * `/v1` + `/testing/v1` producer surface, which exists. Rows whose prerequisite
 * is a corpus, shell, Session or Composer producer are not simulated here —
 * their owners run them when their producer lands (§4.1).
 *
 * The target here is a QA harness that declares the shipped `happier.triage`
 * sources point from the published protocol value and adds only executor
 * Actions to isolate the public source ABI from the shipped aggregate's
 * runtime. `publicSurface.test.mjs` owns the separate ownership census
 * proving that `packages/plugins/triage` is the sole declarer of that point, so
 * the harness cannot quietly admit a shape the real target would not.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageGetResultV1Schema,
    TriageScanResultV1Schema,
    TriageSourcesContributionPointV1,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import { checkTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import {
    LEDGER_ACTION_IDS,
    LEDGER_ACCOUNT_PURPOSE,
    LEDGER_CONNECTED_ACCOUNT_ID,
    LEDGER_CONTRIBUTION_LOCAL_ID,
    activate,
} from '../src/index.mjs';
import { LEDGER_ROW_COUNT, LEDGER_UNAVAILABLE_REF } from '../src/ledger.mjs';
import { mapLedgerPage } from '../src/map.mjs';

const fixtureRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The **shipped** manifest, read from the committed artifact rather than
 * imported from the live module.
 *
 * This suite is the evidence that an outside author can ship a working Triage
 * source, so the thing under test has to be the bytes that author publishes.
 * Driving it from the live export instead let the committed artifact declare an
 * unsupported protocol version while every runtime case stayed green.
 * `publicSurface.test.mjs` separately asserts that this artifact still equals
 * the module's projection, so the two directions cannot drift apart silently.
 */
const manifest = JSON.parse(
    readFileSync(join(fixtureRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
);

const LEDGER_SPACE = 'acme/ledger';
/**
 * The declared QA space (`qa/QA-PROTOCOL.md` QB-57).
 *
 * It is the same provider, page geometry and mapping as the curated space, read
 * through the same configured-instance token: the only difference is which
 * space the ordinary source configuration selected.
 */
const LEDGER_QA_SPACE = 'acme/ledger-qa';
const LEDGER_QA_ROW_COUNT = 2_000;
const LEDGER_QA_PAGE_LIMIT = 100;
const LEDGER_CONTINUATION_SPACES = Object.freeze([
    ['acme/ledger-qa-deep', 500],
    ['acme/ledger-qa-shallow', 3],
]);
/** Every space discovery offers, in the order it reports them. */
const LEDGER_SPACES = Object.freeze([LEDGER_SPACE, LEDGER_QA_SPACE, ...LEDGER_CONTINUATION_SPACES.map(([space]) => space), 'acme/ledger-qa-empty']);
const LISTED_ACCOUNT = Object.freeze({
    service: Object.freeze({ pluginId: 'acme.ledger', localId: LEDGER_CONNECTED_ACCOUNT_ID }),
    accountId: 'account-1',
});

const HARNESS_ACTION_IDS = Object.freeze({
    listInstances: 'harness/execute-list-instances',
    scan: 'harness/execute-scan',
    get: 'harness/execute-get',
});

/** Parsed protocol values are null-prototype; compare them as plain JSON. */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function configuredInstance(sourcePluginId = manifest.id, space = LEDGER_SPACE) {
    return {
        v: 1,
        instance: {
            source: { pluginId: sourcePluginId, localId: LEDGER_CONTRIBUTION_LOCAL_ID },
            sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
        },
        binding: { purpose: LEDGER_ACCOUNT_PURPOSE, account: LISTED_ACCOUNT },
        localInstanceKey: space,
        configuration: { v: 1, token: `space=${space}` },
    };
}

function connectedAccountsService(status = 'complete') {
    return {
        listAccounts: async ({ purpose }) => {
            assert.equal(purpose, LEDGER_ACCOUNT_PURPOSE);
            return {
                status,
                accounts: [{
                    account: LISTED_ACCOUNT,
                    displayName: 'Acme Ledger',
                    state: 'connected',
                    connectedAccountOrigins: [],
                    connectedAccountBases: [],
                }],
            };
        },
    };
}

/** Runs one admitted operation the only way a target may: through its handle. */
function runAdmitted(readOperation) {
    return async (input, context) => {
        const operation = readOperation();
        if (operation === undefined) throw new Error('operation_not_admitted');
        return await context.services.actions.executeAdmittedTargetedOperation(
            operation,
            input,
            { signal: context.signal },
        );
    };
}

function createHarnessTarget(slots) {
    return definePlugin({
        id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        version: '0.0.0',
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './harness-target.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        contributionPoints: {
            [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: TriageSourcesContributionPointV1,
        },
        actions: {
            [HARNESS_ACTION_IDS.listInstances]: {
                title: 'Execute admitted listInstances',
                execution: { target: 'daemon' },
                scopes: ['global'],
                surfaces: ['plugin'],
                dangerLevel: 'safe',
                run: runAdmitted(() => slots.listInstances),
            },
            [HARNESS_ACTION_IDS.scan]: {
                title: 'Execute admitted scan',
                execution: { target: 'daemon' },
                scopes: ['global'],
                surfaces: ['plugin'],
                dangerLevel: 'safe',
                run: runAdmitted(() => slots.scan),
            },
            [HARNESS_ACTION_IDS.get]: {
                title: 'Execute admitted get',
                execution: { target: 'daemon' },
                scopes: ['global'],
                surfaces: ['plugin'],
                dangerLevel: 'safe',
                run: runAdmitted(() => slots.get),
            },
        },
    });
}

/**
 * Installs the source and a target, then hands back exactly what a target may
 * hold: opaque admitted operation handles.
 */
async function install({ accountListingStatus, shipped = manifest } = {}) {
    const source = await createPluginTestkit({
        manifest: shipped,
        module: { activate },
        services: { connectedAccounts: connectedAccountsService(accountListingStatus) },
    });
    const slots = {};
    const harness = createHarnessTarget(slots);
    const target = await createPluginTestkit({
        manifest: harness.manifest,
        module: { activate: harness.activate },
        targetedContributionContributors: [source],
    });

    const conformance = checkTriageSourceContributionV1(shipped);
    assert.equal(conformance.ok, true, JSON.stringify(conformance));
    const [contribution] = conformance.manifest.contributes.targetedPluginContributions.filter(
        (candidate) => candidate.target.pluginId === TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1
            && candidate.target.pointId === TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    );
    assert.ok(contribution);

    for (const role of ['listInstances', 'scan', 'get']) {
        slots[role] = target.issueAdmittedTargetedOperation({
            point: harness.contributionPoints[TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1],
            contributor: { testkit: source, contributionId: LEDGER_CONTRIBUTION_LOCAL_ID },
            role,
            action: { pluginId: shipped.id, localId: contribution.operations[role] },
        });
    }

    return {
        source,
        target,
        point: harness.contributionPoints[TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1],
        listInstances: (input) => target.invokeAction(HARNESS_ACTION_IDS.listInstances, input),
        scan: (input) => target.invokeAction(HARNESS_ACTION_IDS.scan, input),
        get: (input) => target.invokeAction(HARNESS_ACTION_IDS.get, input),
        async dispose() {
            await target.dispose();
            await source.dispose();
        },
    };
}

async function walkEveryPage(installed) {
    const pages = [];
    let input = {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 3 },
    };
    for (let guard = 0; guard < 8; guard += 1) {
        const result = TriageScanResultV1Schema.parse(await installed.scan(input));
        pages.push(result);
        if (result.kind !== 'page') return pages;
        input = {
            v: 1,
            instance: configuredInstance(),
            page: { kind: 'continuation', continuation: result.continuation },
        };
    }
    throw new Error('scan_did_not_terminate');
}

// ---------------------------------------------------------------------------
// QB-01 — public source ABI, admitted with no Triage aggregate edit
// ---------------------------------------------------------------------------

test('QB-01: the happier.triage sources point admits the out-of-tree source with no target edit', async () => {
    const installed = await install();
    try {
        const snapshot = installed.target.readTargetedContributionFixture(installed.point);
        const admitted = snapshot.contributions.filter(
            (contribution) => contribution.contributor.pluginId === manifest.id,
        );

        assert.equal(admitted.length, 1);
        assert.equal(admitted[0].contributor.contributionId, LEDGER_CONTRIBUTION_LOCAL_ID);
        assert.deepEqual(
            Object.keys(admitted[0].operations).filter((role) => admitted[0].operations[role]).sort(),
            ['get', 'listInstances', 'scan'],
        );
        // The target declares the published point value verbatim: it holds no
        // per-source wiring, allowlist, or contributor id.
        assert.equal(
            JSON.stringify(createHarnessTarget({}).manifest.contributes.pluginContributionPoints)
                .includes(manifest.id),
            false,
        );
    } finally {
        await installed.dispose();
    }
});

test('QB-01: install, activation, listInstances, scan and get all work through public entry points', async () => {
    const installed = await install();
    try {
        const listed = await installed.listInstances({ v: 1 });
        assert.equal(listed.kind, 'complete');
        // One candidate per space the account can read. Discovery offers the
        // choice; ordinary source configuration is where a human makes it, so
        // neither space is preselected here and neither is reachable only
        // through an environment or global mode.
        assert.deepEqual(listed.candidates.map((candidate) => candidate.localInstanceKey), LEDGER_SPACES);
        assert.deepEqual(
            listed.candidates.map((candidate) => plain(candidate.configuration)),
            LEDGER_SPACES.map((space) => ({ v: 1, token: `space=${space}` })),
        );
        assert.deepEqual(plain(listed.candidates[0].binding.account), plain(LISTED_ACCOUNT));
        // Discovery produced a draft, never a durable configured instance.
        assert.equal(Object.hasOwn(listed.candidates[0], 'instance'), false);

        const pages = await walkEveryPage(installed);
        const observed = pages.flatMap((page) => page.observations);
        assert.equal(pages.at(-1).kind, 'complete');
        assert.ok(observed.length > 0);

        const first = observed.find((observation) => observation.localRef.entryId === 'CHG-17');
        const read = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance: configuredInstance(),
            localRef: first.localRef,
            lastKnownLocator: first.locator,
        }));
        assert.equal(read.kind, 'present');
        assert.deepEqual(plain(read.localRef), plain(first.localRef));
        // A separately installed source retains the canonical custom-forge
        // identity on both paths; a source without it cannot join a checkout.
        const repository = {
            kind: 'custom',
            deployment: 'https://forge.example.test/Forge',
            repository: 'Team/Repo',
        };
        assert.deepEqual(plain(first.repository), repository);
        assert.deepEqual(plain(read.repository), repository);
    } finally {
        await installed.dispose();
    }
});

test('QB-01: a truncated account listing is reported incomplete, never complete', async () => {
    const installed = await install({ accountListingStatus: 'truncated' });
    try {
        const listed = await installed.listInstances({ v: 1 });

        assert.equal(listed.kind, 'incomplete');
        assert.equal(listed.candidates.length, LEDGER_SPACES.length);
    } finally {
        await installed.dispose();
    }
});

// ---------------------------------------------------------------------------
// QB-02 — the direct detail-only row-fact carrier
// ---------------------------------------------------------------------------

test('QB-02: the list preserves a labelled detail-only fact without inventing a value', async () => {
    const installed = await install();
    try {
        const observed = (await walkEveryPage(installed)).flatMap((page) => page.observations);
        const change = observed.find((observation) => observation.localRef.entryId === 'CHG-17');
        const ownerFact = change.snapshot.facts.find((fact) => fact.id === 'acme/owner');

        assert.deepEqual(plain(ownerFact), {
            id: 'acme/owner',
            label: 'Owner',
            importance: 'supplementary',
            value: { kind: 'detailOnly' },
        });
        // The value exists at the source; only a detail read resolves it, and
        // the strict list projection carries no side channel for it. The
        // mounted-document tests above are where that read actually happens.
        assert.equal(JSON.stringify(change).includes('r.okafor'), false);
    } finally {
        await installed.dispose();
    }
});

test('QB-02: an omitted fact and a detail-only fact are different projections', async () => {
    const [withOwner, withoutOwner] = mapLedgerPage([
        { ref: 'TCK-1', type: 'ticket', headline: 'a', space: LEDGER_SPACE, status: 'open', owner: 'x' },
        { ref: 'TCK-2', type: 'ticket', headline: 'b', space: LEDGER_SPACE, status: 'open' },
    ], LEDGER_SPACE).observations;

    assert.equal(withOwner.snapshot.facts.some((fact) => fact.id === 'acme/owner'), true);
    assert.equal(withoutOwner.snapshot.facts.some((fact) => fact.id === 'acme/owner'), false);
});

// ---------------------------------------------------------------------------
// QB-02 — the mounted detail body actually resolves the fact the list withheld
// ---------------------------------------------------------------------------

/**
 * The live document producer behind this source's declarative detail renderer.
 *
 * A detail surface is only a real answer to QB-02 if the *mounted* body can
 * produce the value the list projection deliberately withheld. A static
 * declarative root cannot: it paints the same bytes for every entry, so a
 * module-level helper that resolves the owner would be proving nothing about
 * anything a reader can reach.
 */
const LEDGER_DETAIL_DOCUMENT_RESOURCE_ID = 'ledger-detail-document';

/**
 * The exact launch input the aggregate mounts a source detail with.
 *
 * `packages/plugins/triage/src/ui/detail/input.ts` builds this value and hands
 * it to `TargetedSurface`, and the host republishes it to the mount's
 * `surface`-scoped Resource reads. Building it here from the source's own scan
 * output is what keeps this a real boundary rather than a hand-written stub of
 * a shape the aggregate does not send.
 */
function detailSurfaceInput(observation, space = LEDGER_SPACE) {
    return {
        v: 1,
        instance: configuredInstance(manifest.id, space),
        observation: {
            entryRef: {
                source: { pluginId: manifest.id, localId: LEDGER_CONTRIBUTION_LOCAL_ID },
                ...plain(observation.localRef),
            },
            observedAtMs: 1_760_000_900_000,
            locator: plain(observation.locator),
            snapshot: plain(observation.snapshot),
            viewer: plain(observation.viewer),
        },
        linkedSessions: [],
    };
}

async function readDetailDocument(installed, context) {
    const runtime = installed.source.registration('resources', LEDGER_DETAIL_DOCUMENT_RESOURCE_ID);
    assert.ok(runtime, 'the source registers no detail document producer');
    const produced = await runtime.read(createTestResourceInvocationContext({ signal: new AbortController().signal, context }));
    const text = typeof produced === 'string' ? produced : new TextDecoder().decode(produced);
    return JSON.parse(text);
}

/** Flattens the document's labelled values, which is what a reader sees. */
function documentValues(document) {
    const values = {};
    const visit = (node) => {
        if (node === null || typeof node !== 'object') return;
        if (node.kind === 'status') values[node.label] = node.value;
        for (const child of node.children ?? []) visit(child);
    };
    visit(document.root);
    return values;
}

async function scannedEntry(installed, entryId, space = LEDGER_SPACE) {
    const pages = [];
    let input = { v: 1, instance: configuredInstance(manifest.id, space), page: { kind: 'initial', limit: 100 } };
    for (let guard = 0; guard < 4; guard += 1) {
        const result = TriageScanResultV1Schema.parse(await installed.scan(input));
        pages.push(result);
        const found = result.observations.find((o) => o.localRef.entryId === entryId);
        if (found !== undefined) return found;
        if (result.kind !== 'page') break;
        input = {
            v: 1,
            instance: configuredInstance(manifest.id, space),
            page: { kind: 'continuation', continuation: result.continuation },
        };
    }
    throw new Error(`scan_never_observed_${entryId}`);
}

test('QB-02: the mounted detail document resolves the selected entry\'s owner the list withheld', async () => {
    const installed = await install();
    try {
        const change = await scannedEntry(installed, 'CHG-17');
        // The list still carries the labelled fact without its value.
        assert.equal(JSON.stringify(change).includes('r.okafor'), false);

        const document = await readDetailDocument(installed, {
            kind: 'surface',
            mountInstanceKey: 'acme-ledger/change/CHG-17',
            launchInput: detailSurfaceInput(change),
        });

        assert.equal(document.version, 1);
        const values = documentValues(document);
        assert.equal(values.Owner, 'r.okafor');
        // The document names the entry it answered for, so a reader can tell
        // this body apart from one that resolved a different selection.
        assert.equal(values.Entry, `${LEDGER_SPACE} CHG-17`);
    } finally {
        await installed.dispose();
    }
});

test('QB-02: the detail document answers for the exact selected entry across both spaces', async () => {
    const installed = await install();
    try {
        // Same shared ledger, different configured space: the owner is the one
        // this entry actually carries, not a value cached from the first read.
        const qaEntry = await scannedEntry(installed, 'LGQ-3', LEDGER_QA_SPACE);
        const qaDocument = await readDetailDocument(installed, {
            kind: 'surface',
            mountInstanceKey: 'acme-ledger/ticket/LGQ-3',
            launchInput: detailSurfaceInput(qaEntry, LEDGER_QA_SPACE),
        });
        assert.equal(documentValues(qaDocument).Owner, 's.nakamura');
        assert.equal(documentValues(qaDocument).Entry, `${LEDGER_QA_SPACE} LGQ-3`);

        // An entry whose provider row carries no owner gets no invented value,
        // exactly as the list projection omits the fact for it.
        const withoutOwner = await scannedEntry(installed, 'CHG-18');
        assert.equal(withoutOwner.snapshot.facts.some((fact) => fact.id === 'acme/owner'), false);
        const plainDocument = await readDetailDocument(installed, {
            kind: 'surface',
            mountInstanceKey: 'acme-ledger/change/CHG-18',
            launchInput: detailSurfaceInput(withoutOwner),
        });
        assert.equal(documentValues(plainDocument).Owner, 'No owner is recorded for this entry.');
    } finally {
        await installed.dispose();
    }
});

test('QB-02: a detail mount the source cannot authorize resolves nothing at all', async () => {
    const installed = await install();
    try {
        const change = await scannedEntry(installed, 'CHG-17');

        // The configured instance says one space and the selected entry says
        // another. Answering from the configured space would hand the reader a
        // different entry's owner under the selected entry's name.
        const crossed = detailSurfaceInput(change);
        crossed.observation.entryRef.collisionScope = LEDGER_QA_SPACE;
        const crossedDocument = await readDetailDocument(installed, {
            kind: 'surface',
            mountInstanceKey: 'acme-ledger/change/CHG-17',
            launchInput: crossed,
        });
        assert.equal(JSON.stringify(crossedDocument).includes('r.okafor'), false);

        // A read with no mounted surface has no selection to answer for.
        const unmounted = await readDetailDocument(installed, { kind: 'global' });
        assert.equal(JSON.stringify(unmounted).includes('r.okafor'), false);

        // And a launch input the published contract refuses is refused whole
        // rather than partially believed.
        const malformed = await readDetailDocument(installed, {
            kind: 'surface',
            mountInstanceKey: 'acme-ledger/change/CHG-17',
            launchInput: { v: 1, instance: configuredInstance(), linkedSessions: [] },
        });
        assert.equal(JSON.stringify(malformed).includes('r.okafor'), false);
    } finally {
        await installed.dispose();
    }
});

// ---------------------------------------------------------------------------
// QB-03 — additive outer fields drop; closed arms reject atomically
// ---------------------------------------------------------------------------

test('QB-03: an unknown additive outer snapshot field is dropped while its entry survives', () => {
    const base = mapLedgerPage([
        { ref: 'TCK-1', type: 'ticket', headline: 'a', space: LEDGER_SPACE, status: 'open' },
    ], LEDGER_SPACE).observations[0];

    const parsed = TriageScanResultV1Schema.parse({
        kind: 'complete',
        observations: [{
            ...base,
            snapshot: { ...base.snapshot, futureAdditiveField: { anything: true } },
        }],
        evidence: { kind: 'walkFinished' },
    });

    assert.equal(parsed.observations.length, 1);
    assert.equal(Object.hasOwn(parsed.observations[0].snapshot, 'futureAdditiveField'), false);
    assert.equal(parsed.observations[0].snapshot.title, 'a');
});

test('QB-03: an unknown closed row-fact kind rejects the whole result atomically', () => {
    const base = mapLedgerPage([
        { ref: 'TCK-1', type: 'ticket', headline: 'a', space: LEDGER_SPACE, status: 'open' },
    ], LEDGER_SPACE).observations[0];
    const sibling = mapLedgerPage([
        { ref: 'TCK-2', type: 'ticket', headline: 'b', space: LEDGER_SPACE, status: 'open' },
    ], LEDGER_SPACE).observations[0];

    const result = TriageScanResultV1Schema.safeParse({
        kind: 'complete',
        observations: [
            sibling,
            {
                ...base,
                snapshot: {
                    ...base.snapshot,
                    facts: [{
                        id: 'acme/future',
                        importance: 'primary',
                        value: { kind: 'sparkline', points: [1, 2] },
                    }],
                },
            },
        ],
        evidence: { kind: 'walkFinished' },
    });

    assert.equal(result.success, false);
});

test('QB-03: one malformed raw row is omitted and counted while its valid siblings map', async () => {
    const installed = await install();
    try {
        const pages = await walkEveryPage(installed);
        const observed = pages.flatMap((page) => page.observations);
        const omitted = pages
            .map((page) => (page.evidence.kind === 'partial' ? page.evidence.omittedItemCount : 0))
            .reduce((total, count) => total + count, 0);

        assert.equal(observed.length + omitted, LEDGER_ROW_COUNT);
        assert.equal(omitted, 2);
        assert.equal(
            pages.some((page) => page.evidence.kind === 'partial'
                && page.evidence.reason === 'acme/unmappable-rows'),
            true,
        );
        // No malformed raw byte reaches the strict result.
        const serialized = JSON.stringify(observed);
        assert.equal(serialized.includes('structured headline'), false);
        assert.equal(serialized.includes('Row with no provider identity'), false);
    } finally {
        await installed.dispose();
    }
});

test('QB-03: presentation "unknown" stays a valid nonterminal state, never raw authority', () => {
    const [observation] = mapLedgerPage([{
        ref: 'TCK-9',
        type: 'ticket',
        headline: 'Provider state this source does not model',
        space: LEDGER_SPACE,
        status: 'quarantined',
    }], LEDGER_SPACE).observations;

    assert.deepEqual(observation.snapshot.state, {
        presentation: 'unknown',
        nativeLabel: 'quarantined',
    });
    assert.equal(TriageScanResultV1Schema.safeParse({
        kind: 'complete',
        observations: [observation],
        evidence: { kind: 'walkFinished' },
    }).success, true);
});

// ---------------------------------------------------------------------------
// QB-04 — required source authority variants fail at admission
// ---------------------------------------------------------------------------

function mutableManifest() {
    return JSON.parse(JSON.stringify(manifest));
}

for (const [name, mutate, expected] of [
    ['a wrong target plugin id', (declared) => {
        declared.contributes.targetedPluginContributions[0].target.pluginId = 'acme.other-aggregate';
    }, 'exactly one'],
    ['a wrong contribution point id', (declared) => {
        declared.contributes.targetedPluginContributions[0].target.pointId = 'entries';
    }, 'exactly one'],
    ['a wrong protocol version', (declared) => {
        declared.contributes.targetedPluginContributions[0].protocol.version = 2;
    }, 'version 1'],
    ['a role bound to an undeclared Action', (declared) => {
        declared.contributes.targetedPluginContributions[0].operations.get = 'ledger/not-declared';
    }, 'undeclared Action'],
    ['an undefined source role', (declared) => {
        declared.contributes.targetedPluginContributions[0].operations.search = LEDGER_ACTION_IDS.get;
    }, "source role 'search'"],
]) {
    test(`QB-04: admission rejects ${name}`, () => {
        const declared = mutableManifest();
        mutate(declared);
        const result = checkTriageSourceContributionV1(declared);

        assert.equal(result.ok, false);
        assert.match(result.errors.join(' '), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    });
}

test('QB-04: a rejected declaration is not admitted at the contribution point either', async () => {
    const declared = mutableManifest();
    declared.contributes.targetedPluginContributions[0].protocol.version = 2;

    const source = await createPluginTestkit({
        manifest: declared,
        module: { activate },
        services: { connectedAccounts: connectedAccountsService() },
    });
    const harness = createHarnessTarget({});
    const target = await createPluginTestkit({
        manifest: harness.manifest,
        module: { activate: harness.activate },
        targetedContributionContributors: [source],
    });
    try {
        const snapshot = target.readTargetedContributionFixture(
            harness.contributionPoints[TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1],
        );
        assert.deepEqual(
            snapshot.contributions.filter((c) => c.contributor.pluginId === declared.id),
            [],
        );
    } finally {
        await target.dispose();
        await source.dispose();
    }
});

// ---------------------------------------------------------------------------
// QB-05 — continuation custody
// ---------------------------------------------------------------------------

test('QB-05: no source operation input or result can carry durable resume state', () => {
    const forbidden = /checkpoint|watermark|epoch|deferred|resumeToken|frontier|sinceCursor/iu;
    const declarations = Object.entries(TriageSourcesContributionProtocolV1.operations);

    for (const [role, operation] of declarations) {
        const { declaration } = operation;
        const fieldNames = [];
        JSON.stringify({
            input: declaration.input.kind === 'protocolDefined'
                ? declaration.input.schema.jsonSchema
                : null,
            result: declaration.resultSchema.jsonSchema,
        }, (key, value) => {
            // This is the SCM-owned comparison grammar, not source paging
            // authority. Its checkpointReceiptId identifies review evidence.
            if (key === 'comparisonSource') return undefined;
            if (key === 'properties') fieldNames.push(...Object.keys(value));
            return value;
        });
        // Domain literals such as a review revision's checkpoint kind do not
        // grant the source a durable scan cursor. Judge field authority, not
        // arbitrary words appearing anywhere in the canonical schema.
        assert.equal(forbidden.test(fieldNames.join(' ')), false, `${role} exposes durable resume state`);
    }
});

test('QB-05: a continuation is invocation-local, so an abandoned walk restarts at initial', async () => {
    const installed = await install();
    try {
        const first = TriageScanResultV1Schema.parse(await installed.scan({
            v: 1,
            instance: configuredInstance(),
            page: { kind: 'initial', limit: 3 },
        }));
        assert.equal(first.kind, 'page');

        // Abandon the invocation. A fresh trigger has no continuation to send,
        // and the only page arm it can construct is `initial`.
        const restarted = TriageScanResultV1Schema.parse(await installed.scan({
            v: 1,
            instance: configuredInstance(),
            page: { kind: 'initial', limit: 3 },
        }));

        assert.deepEqual(plain(restarted.observations), plain(first.observations));
    } finally {
        await installed.dispose();
    }
});

test('QB-05: the continuation arm cannot restate a limit, so a mid-scan limit change is unrepresentable', async () => {
    const installed = await install();
    try {
        const first = TriageScanResultV1Schema.parse(await installed.scan({
            v: 1,
            instance: configuredInstance(),
            page: { kind: 'initial', limit: 3 },
        }));

        const withRestatedLimit = TriageScanResultV1Schema.safeParse({
            kind: 'page',
            observations: first.observations,
            evidence: first.evidence,
            continuation: { ...first.continuation, limit: 64 },
        });

        assert.equal(withRestatedLimit.success, false);
        assert.equal(Object.keys(first.continuation).sort().join(','), 'token,v');
    } finally {
        await installed.dispose();
    }
});

test('QB-05: a page never exceeds the submitted limit once omissions are counted', async () => {
    const installed = await install();
    try {
        for (const page of await walkEveryPage(installed)) {
            if (page.kind === 'failed') continue;
            const omitted = page.evidence.kind === 'partial'
                ? page.evidence.omittedItemCount ?? 0
                : 0;
            assert.ok(page.observations.length + omitted <= 3);
        }
    } finally {
        await installed.dispose();
    }
});

// ---------------------------------------------------------------------------
// QB-57 — the declared QA space is a real source for the loaded list recipe
// ---------------------------------------------------------------------------

for (const [space, count] of LEDGER_CONTINUATION_SPACES) {
    test(`QB-86: ${space} scans exactly ${count} observations and resolves its last entry`, async () => {
        const installed = await install();
        try {
            const instance = configuredInstance(manifest.id, space);
            const seen = new Set();
            let input = { v: 1, instance, page: { kind: 'initial', limit: 37 } };
            let result;
            do {
                result = TriageScanResultV1Schema.parse(await installed.scan(input));
                for (const observation of result.observations) {
                    assert.equal(observation.localRef.collisionScope, space);
                    assert.equal(seen.has(observation.localRef.entryId), false);
                    seen.add(observation.localRef.entryId);
                }
                assert.ok(seen.size <= count);
                if (result.kind === 'page') input = {
                    v: 1, instance, page: { kind: 'continuation', continuation: result.continuation },
                };
            } while (result.kind === 'page');
            assert.equal(result.kind, 'complete');
            assert.deepEqual(plain(result.evidence), { kind: 'walkFinished' });
            assert.equal(seen.size, count);
            const localRef = {
                kindId: (count - 1) % 2 === 0 ? 'change' : 'ticket',
                collisionScope: space,
                entryId: `LGQ-${count - 1}`,
            };
            const exact = TriageGetResultV1Schema.parse(await installed.get({ v: 1, instance, localRef }));
            assert.equal(exact.kind, 'present');
            assert.equal(exact.snapshot.scopeLabel, space);
            const beyond = TriageGetResultV1Schema.parse(await installed.get({
                v: 1, instance, localRef: { kindId: 'change', collisionScope: space, entryId: `LGQ-${count}` },
            }));
            assert.equal(beyond.kind, 'absent');
        } finally {
            await installed.dispose();
        }
    });
}

test('QB-57: the configured QA space pages 2,000 real entries through the same scan owner', async () => {
    // QB-57's workload is 2,000 mixed entries. A performance recipe run against
    // a six-row fixture measures nothing, and a source that quietly returned
    // the small space for a QA-space configuration would look identical in
    // every schema check — so this walks the whole space and counts it.
    const installed = await install();
    try {
        const instance = configuredInstance(manifest.id, LEDGER_QA_SPACE);
        const seen = new Set();
        let pages = 0;
        let evidence = null;
        let input = { v: 1, instance, page: { kind: 'initial', limit: LEDGER_QA_PAGE_LIMIT } };

        for (let guard = 0; guard <= LEDGER_QA_ROW_COUNT / LEDGER_QA_PAGE_LIMIT; guard += 1) {
            const result = TriageScanResultV1Schema.parse(await installed.scan(input));
            pages += 1;
            assert.ok(result.observations.length <= LEDGER_QA_PAGE_LIMIT);
            for (const observation of result.observations) {
                assert.equal(observation.localRef.collisionScope, LEDGER_QA_SPACE);
                assert.equal(
                    seen.has(observation.localRef.entryId),
                    false,
                    `the walk repeated ${observation.localRef.entryId}`,
                );
                seen.add(observation.localRef.entryId);
            }
            if (result.kind !== 'page') {
                assert.equal(result.kind, 'complete');
                evidence = result.evidence;
                break;
            }
            input = {
                v: 1,
                instance,
                page: { kind: 'continuation', continuation: result.continuation },
            };
        }

        assert.equal(seen.size, LEDGER_QA_ROW_COUNT);
        assert.equal(pages, LEDGER_QA_ROW_COUNT / LEDGER_QA_PAGE_LIMIT);
        // The QA space carries no unmappable row: a partial walk would shrink
        // the workload the recipe is supposed to measure.
        assert.deepEqual(plain(evidence), { kind: 'walkFinished' });

        // A deep entry is authoritative without any walk at all, so the recipe
        // can open a detail from a window it never scanned to.
        const deep = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance,
            localRef: {
                kindId: 'ticket',
                collisionScope: LEDGER_QA_SPACE,
                entryId: `LGQ-${LEDGER_QA_ROW_COUNT - 1}`,
            },
        }));
        assert.equal(deep.kind, 'present');
        assert.equal(deep.snapshot.scopeLabel, LEDGER_QA_SPACE);

        const beyond = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance,
            localRef: {
                kindId: 'ticket',
                collisionScope: LEDGER_QA_SPACE,
                entryId: `LGQ-${LEDGER_QA_ROW_COUNT}`,
            },
        }));
        assert.equal(beyond.kind, 'absent');
    } finally {
        await installed.dispose();
    }
});

test('QB-57: the two spaces stay separate entry sets under the same configured source', async () => {
    const installed = await install();
    try {
        // Reading a curated entry through a QA-space instance is a scope
        // mismatch, never an absence claim: the spaces are different sets, and
        // conflating them would let one configuration erase the other's rows.
        const crossed = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance: configuredInstance(manifest.id, LEDGER_QA_SPACE),
            localRef: { kindId: 'ticket', collisionScope: LEDGER_SPACE, entryId: 'TCK-204' },
        }));
        assert.equal(crossed.kind, 'unresolved');
        assert.equal(crossed.failure.code, 'acme/instance-scope-mismatch');

        // And a QA entry id read inside the QA space resolves, so the mismatch
        // above is about the configured scope rather than an unknown id.
        const inSpace = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance: configuredInstance(manifest.id, LEDGER_QA_SPACE),
            localRef: { kindId: 'change', collisionScope: LEDGER_QA_SPACE, entryId: 'LGQ-0' },
        }));
        assert.equal(inSpace.kind, 'present');

        // The curated space's deliberately unreachable row is a curated fact.
        // In the QA space that id is simply not there, and reporting it as a
        // transient outage would tell the aggregate to retry forever for an
        // entry this space never had.
        const foreign = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance: configuredInstance(manifest.id, LEDGER_QA_SPACE),
            localRef: {
                kindId: 'ticket',
                collisionScope: LEDGER_QA_SPACE,
                entryId: LEDGER_UNAVAILABLE_REF,
            },
        }));
        assert.equal(foreign.kind, 'absent');
    } finally {
        await installed.dispose();
    }
});

test('QB-04: a configured token naming a space this source does not serve fails, never empties', async () => {
    const installed = await install();
    try {
        const instance = configuredInstance(manifest.id, 'acme/ledger-retired');
        const result = TriageScanResultV1Schema.parse(await installed.scan({
            v: 1,
            instance,
            page: { kind: 'initial', limit: 3 },
        }));

        // An empty successful walk would tell the aggregate the source is
        // healthy and has nothing, which is the one answer this source cannot
        // truthfully give about a space it cannot read.
        assert.equal(result.kind, 'failed');
        assert.equal(result.failure.code, 'acme/unreadable-source-token');
    } finally {
        await installed.dispose();
    }
});

// ---------------------------------------------------------------------------
// Authoritative read arms — only `get` may conclude absence
// ---------------------------------------------------------------------------

test('QB-05/QB-01: get carries all four arms while scan carries none of absence', async () => {
    const installed = await install();
    try {
        const read = async (entryId, kindId = 'ticket') => TriageGetResultV1Schema.parse(
            await installed.get({
                v: 1,
                instance: configuredInstance(),
                localRef: { kindId, collisionScope: LEDGER_SPACE, entryId },
            }),
        );

        assert.equal((await read('TCK-204')).kind, 'present');
        assert.equal((await read('TCK-900')).kind, 'absent');
        assert.equal((await read(LEDGER_UNAVAILABLE_REF)).kind, 'unresolved');

        const merged = await read('TCK-206');
        assert.equal(merged.kind, 'merged');
        assert.deepEqual(plain(merged.successor), {
            kindId: 'ticket',
            collisionScope: LEDGER_SPACE,
            entryId: 'TCK-204',
        });

        const scanned = (await walkEveryPage(installed)).flatMap((page) => page.observations);
        assert.equal(scanned.some((observation) => observation.kind === 'absent'), false);
    } finally {
        await installed.dispose();
    }
});

test('QB-04: an exact read through a mismatched configured instance is unresolved, never absent', async () => {
    const installed = await install();
    try {
        const read = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance: configuredInstance(),
            localRef: { kindId: 'ticket', collisionScope: 'acme/other-space', entryId: 'TCK-204' },
        }));

        assert.equal(read.kind, 'unresolved');
        assert.equal(read.failure.code, 'acme/instance-scope-mismatch');
    } finally {
        await installed.dispose();
    }
});

// ---------------------------------------------------------------------------
// QB-06 — a retired contributor cannot still be dispatched to
// ---------------------------------------------------------------------------

test('QB-06: an admitted handle stops dispatching once its contributor is retired', async () => {
    // The target keeps the handle it was issued; only the contributor goes away.
    // A handle that still resolves here is stale dispatch — the target would be
    // reading a source that is no longer installed and calling the answer
    // current.
    const installed = await install();
    let retired = false;
    try {
        const before = TriageGetResultV1Schema.parse(await installed.get({
            v: 1,
            instance: configuredInstance(),
            localRef: { kindId: 'ticket', collisionScope: LEDGER_SPACE, entryId: 'TCK-204' },
        }));
        assert.equal(before.kind, 'present');

        await installed.source.dispose();
        retired = true;

        // Named, not merely thrown: the refusal has to come from the retired
        // contributor. A target that had been disposed itself would refuse too,
        // and that would prove nothing about stale dispatch.
        await assert.rejects(
            async () => installed.get({
                v: 1,
                instance: configuredInstance(),
                localRef: { kindId: 'ticket', collisionScope: LEDGER_SPACE, entryId: 'TCK-204' },
            }),
            (error) => {
                assert.match(error.message, /contributor generation is no longer current/u);
                assert.equal(/disposed/u.test(error.message), false);
                return true;
            },
        );
    } finally {
        await installed.target.dispose();
        if (!retired) await installed.source.dispose();
    }
});

// ---------------------------------------------------------------------------
// QB-59 — a packed third-party source keeps its declared capability
// ---------------------------------------------------------------------------

test('QB-59: an unrecognised vendor id is admitted and executes identically', async () => {
    // `acme.ledger` has been in this repository's fixtures long enough that a
    // host allowlist keyed on it would go unnoticed. This installs a vendor id
    // that appears nowhere else, so admission has nothing to recognise: if the
    // target, the contribution point, or operation dispatch consulted a list of
    // trusted source plugins, this is the source that would fail.
    const unrecognised = mutableManifest();
    unrecognised.id = 'zzz.unlisted-vendor';

    const known = await install();
    const unknown = await install({ shipped: unrecognised });
    try {
        const read = async (installed, sourcePluginId) => TriageGetResultV1Schema.parse(
            await installed.get({
                v: 1,
                instance: configuredInstance(sourcePluginId),
                localRef: { kindId: 'ticket', collisionScope: LEDGER_SPACE, entryId: 'TCK-204' },
            }),
        );
        const knownRead = await read(known, manifest.id);
        const unknownRead = await read(unknown, unrecognised.id);

        assert.equal(unknownRead.kind, 'present');
        assert.deepEqual(plain(unknownRead.snapshot), plain(knownRead.snapshot));

        // Its admitted projection is the same projection, not a narrowed one:
        // a host that wrapped, filtered, or downgraded an unrecognised vendor
        // would differ here, and comparing against the known source's admitted
        // shape is what makes that visible.
        const project = (installed, pluginId) => {
            const admitted = installed.target
                .readTargetedContributionFixture(installed.point)
                .contributions
                .find((contribution) => contribution.contributor.pluginId === pluginId);
            return {
                keys: Object.keys(admitted).sort(),
                contributionId: admitted.contributor.contributionId,
                protocol: plain(admitted.protocol),
                operations: Object.keys(admitted.operations).sort(),
            };
        };

        assert.deepEqual(project(unknown, unrecognised.id), project(known, manifest.id));
        // The surface the source declared stays a declaration fact: the admitted
        // projection carries no surface at all, which is why `publicContractCensus`
        // decides the detail surface over the shipped artifact instead.
        assert.equal(project(unknown, unrecognised.id).keys.includes('surfaces'), false);
    } finally {
        await unknown.dispose();
        await known.dispose();
    }
});
