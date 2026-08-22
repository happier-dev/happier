/**
 * `qa/QA-PROTOCOL.md` QB-20, QB-22 and QB-59 as runnable cases, decided over the
 * published `/v1` schema and the shipped fixture artifact.
 *
 * Every census here is written as a pure function over the shape it judges, and
 * every census is exercised twice: once against the real published shape, and
 * once against a deliberately wrong shape that names the implementation the row
 * exists to reject. A census that only ever sees the correct input certifies
 * nothing — it cannot distinguish a contract that holds from one that has been
 * widened underneath it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';

const fixtureRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(fixtureRoot, '..', '..', '..', '..', '..');

/** The shipped artifact, not the live module projection. See `sourceAbiConformance`. */
const shippedManifest = JSON.parse(
    readFileSync(join(fixtureRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
);

const scanResultSchema = TriageSourcesContributionProtocolV1
    .operations.scan.declaration.resultSchema.jsonSchema;
const getResultSchema = TriageSourcesContributionProtocolV1
    .operations.get.declaration.resultSchema.jsonSchema;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** Normalizes one discriminated-union arm into the facts a census can judge. */
function readUnionArms(schema) {
    const arms = schema.anyOf ?? schema.oneOf;
    if (!Array.isArray(arms)) return null;
    return arms.map((arm) => ({
        kind: arm.properties?.kind?.const,
        properties: Object.keys(arm.properties ?? {}).sort(),
        required: [...(arm.required ?? [])].sort(),
        closed: arm.additionalProperties === false,
    }));
}

// ---------------------------------------------------------------------------
// QB-22 — scan evidence is enumeration health and nothing else
// ---------------------------------------------------------------------------

/**
 * Semantics `qa/QA-PROTOCOL.md` QB-22 forbids health from carrying. Each one is
 * a real way health gets promoted into an authority it does not have: a
 * watermark or epoch turns it into durable resume state, a window or scope
 * turns it into a delta claim, and a completeness or total field turns it into
 * set-complement absence.
 */
const FORBIDDEN_HEALTH_SEMANTICS = /mode|scope|window|watermark|instance|checkpoint|epoch|total|complete|absent|remaining|frontier/iu;

const EXPECTED_HEALTH_ARMS = Object.freeze({
    walkFinished: { properties: ['kind'], required: ['kind'] },
    partial: { properties: ['kind', 'omittedItemCount', 'reason'], required: ['kind', 'reason'] },
    moving: { properties: ['kind', 'reason'], required: ['kind', 'reason'] },
});

/**
 * Judges every scan-evidence carrier in a scan result schema.
 *
 * Returns the findings that hold; an empty array is conformance. It reads the
 * evidence out of each result arm that carries one rather than being handed a
 * single carrier, so an implementation that widened health in only one arm is
 * still caught.
 */
export function censusScanEvidence(schema) {
    const findings = [];
    const resultArms = schema.anyOf ?? schema.oneOf;
    if (!Array.isArray(resultArms)) return ['scan result is not a discriminated union'];

    const carriers = [];
    for (const arm of resultArms) {
        const kind = arm.properties?.kind?.const;
        const evidence = arm.properties?.evidence;
        if (evidence === undefined) continue;
        carriers.push({ resultKind: kind, evidence });
    }
    if (carriers.length === 0) return ['no scan result arm carries enumeration evidence'];

    for (const carrier of carriers) {
        const arms = readUnionArms(carrier.evidence);
        if (arms === null) {
            findings.push(`${carrier.resultKind}: evidence is not a discriminated union`);
            continue;
        }
        const kinds = arms.map((arm) => arm.kind).sort();
        const expected = Object.keys(EXPECTED_HEALTH_ARMS).sort();
        if (kinds.join(',') !== expected.join(',')) {
            findings.push(`${carrier.resultKind}: evidence arms are ${kinds.join(',')}, not ${expected.join(',')}`);
        }
        for (const arm of arms) {
            const contract = EXPECTED_HEALTH_ARMS[arm.kind];
            if (contract === undefined) continue;
            if (!arm.closed) findings.push(`${carrier.resultKind}/${arm.kind}: arm is open`);
            if (arm.properties.join(',') !== contract.properties.join(',')) {
                findings.push(`${carrier.resultKind}/${arm.kind}: carries ${arm.properties.join(',')}`);
            }
            if (arm.required.join(',') !== contract.required.join(',')) {
                findings.push(`${carrier.resultKind}/${arm.kind}: requires ${arm.required.join(',')}`);
            }
            for (const property of arm.properties) {
                if (property === 'kind') continue;
                if (FORBIDDEN_HEALTH_SEMANTICS.test(property)) {
                    findings.push(`${carrier.resultKind}/${arm.kind}: '${property}' gives health an authority it does not have`);
                }
            }
        }
    }
    return findings;
}

test('QB-22: published scan evidence carries only bounded enumeration health', () => {
    assert.deepEqual(censusScanEvidence(scanResultSchema), []);

    // The census is looking at every carrier, not one sample: both non-failed
    // scan arms report health, and a census that read only the first would be
    // half blind.
    const carriers = (scanResultSchema.anyOf ?? scanResultSchema.oneOf)
        .filter((arm) => arm.properties?.evidence !== undefined)
        .map((arm) => arm.properties.kind.const)
        .sort();
    assert.deepEqual(carriers, ['complete', 'page']);
});

test('QB-22: the census rejects health promoted into watermark, completeness or absence authority', () => {
    // Wrong implementation 1: health gains durable resume state.
    const withWatermark = clone(scanResultSchema);
    const partialOf = (schema, resultKind) => (schema.anyOf ?? schema.oneOf)
        .find((arm) => arm.properties?.kind?.const === resultKind)
        .properties.evidence.anyOf
        .find((arm) => arm.properties.kind.const === 'partial');
    partialOf(withWatermark, 'page').properties.watermark = { type: 'string' };
    partialOf(withWatermark, 'page').required.push('watermark');
    assert.ok(censusScanEvidence(withWatermark).some((f) => f.includes('watermark')));

    // Wrong implementation 2: health gains a fourth arm that establishes absence.
    const withAbsence = clone(scanResultSchema);
    const pageEvidence = (withAbsence.anyOf ?? withAbsence.oneOf)
        .find((arm) => arm.properties?.kind?.const === 'page').properties.evidence;
    pageEvidence.anyOf.push({
        type: 'object',
        properties: { kind: { const: 'setComplete' } },
        required: ['kind'],
        additionalProperties: false,
    });
    assert.ok(censusScanEvidence(withAbsence).some((f) => f.includes('evidence arms are')));

    // Wrong implementation 3: an open arm, so health can carry anything later
    // without any schema change at all.
    const opened = clone(scanResultSchema);
    delete partialOf(opened, 'complete').additionalProperties;
    assert.ok(censusScanEvidence(opened).some((f) => f.includes('arm is open')));

    // Wrong implementation 4: health is widened in only one of the two carriers.
    const oneCarrierWidened = clone(scanResultSchema);
    partialOf(oneCarrierWidened, 'complete').properties.scanWindowMs = { type: 'integer' };
    const findings = censusScanEvidence(oneCarrierWidened);
    assert.ok(findings.some((f) => f.startsWith('complete/partial')));
    assert.ok(findings.every((f) => !f.startsWith('page/')));
});

// ---------------------------------------------------------------------------
// QB-20 — only the exact `absent` arm of `get` establishes absence
// ---------------------------------------------------------------------------

const EXPECTED_GET_ARMS = Object.freeze({
    present: { required: ['kind', 'localRef', 'locator', 'snapshot', 'viewer'] },
    absent: { required: ['kind', 'localRef'] },
    merged: { required: ['kind', 'localRef', 'successor'] },
    unresolved: { required: ['failure', 'kind', 'localRef'] },
});

/**
 * Judges which arms may conclude absence.
 *
 * The failure this decides is not "an arm went missing" — it is the reverse:
 * an implementation that lets a *failure* or an enumeration walk conclude that
 * an entry is gone. So it asserts that `absent` carries no failure, successor
 * or evidence payload that could justify it, and that no scan arm can express
 * absence at all.
 */
export function censusAuthoritativeReadArms(getSchema, scanSchema) {
    const findings = [];
    const arms = readUnionArms(getSchema);
    if (arms === null) return ['get result is not a discriminated union'];

    const kinds = arms.map((arm) => arm.kind).sort();
    const expected = Object.keys(EXPECTED_GET_ARMS).sort();
    if (kinds.join(',') !== expected.join(',')) {
        findings.push(`get arms are ${kinds.join(',')}, not exactly ${expected.join(',')}`);
    }
    for (const arm of arms) {
        const contract = EXPECTED_GET_ARMS[arm.kind];
        if (contract === undefined) continue;
        if (!arm.closed) findings.push(`get/${arm.kind}: arm is open`);
        if (arm.required.join(',') !== contract.required.join(',')) {
            findings.push(`get/${arm.kind}: requires ${arm.required.join(',')}, not ${contract.required.join(',')}`);
        }
    }

    const absent = arms.find((arm) => arm.kind === 'absent');
    if (absent !== undefined) {
        for (const property of absent.properties) {
            if (property === 'kind' || property === 'localRef') {
                continue;
            }
            findings.push(`get/absent: '${property}' would let something other than the read itself conclude absence`);
        }
    }

    const scanArms = readUnionArms(scanSchema);
    if (scanArms === null) return [...findings, 'scan result is not a discriminated union'];
    for (const arm of scanArms) {
        if (arm.kind === 'absent' || arm.kind === 'missing' || arm.kind === 'removed') {
            findings.push(`scan/${arm.kind}: enumeration cannot establish absence`);
        }
        for (const property of arm.properties) {
            if (/absent|missing|removed|deleted|complement/iu.test(property)) {
                findings.push(`scan/${arm.kind}: '${property}' lets a walk conclude absence`);
            }
        }
    }
    return findings;
}

test('QB-20: get keeps exactly four arms and only its own absent arm concludes absence', () => {
    assert.deepEqual(censusAuthoritativeReadArms(getResultSchema, scanResultSchema), []);
});

test('QB-20: the census rejects a fifth arm, a justified absence, and an absence-bearing walk', () => {
    // Wrong implementation 1: a fifth arm splits absence into two meanings.
    const fifthArm = clone(getResultSchema);
    (fifthArm.anyOf ?? fifthArm.oneOf).push({
        type: 'object',
        properties: { kind: { const: 'notFound' }, localRef: { type: 'object' } },
        required: ['kind', 'localRef'],
        additionalProperties: false,
    });
    assert.ok(censusAuthoritativeReadArms(fifthArm, scanResultSchema)
        .some((f) => f.includes('not exactly')));

    // Wrong implementation 2: `absent` gains a failure, so a transport error can
    // be reported as "the entry is gone" — the exact conflation QB-20 forbids.
    const justifiedAbsence = clone(getResultSchema);
    const absentArm = (justifiedAbsence.anyOf ?? justifiedAbsence.oneOf)
        .find((arm) => arm.properties.kind.const === 'absent');
    absentArm.properties.failure = { type: 'object' };
    assert.ok(censusAuthoritativeReadArms(justifiedAbsence, scanResultSchema)
        .some((f) => f.includes("get/absent: 'failure'")));

    // Wrong implementation 3: a completed walk reports the entries it did not
    // see, so the scan complement becomes deletion evidence.
    const walkKnowsAbsence = clone(scanResultSchema);
    (walkKnowsAbsence.anyOf ?? walkKnowsAbsence.oneOf)
        .find((arm) => arm.properties.kind.const === 'complete')
        .properties.absentRefs = { type: 'array' };
    assert.ok(censusAuthoritativeReadArms(getResultSchema, walkKnowsAbsence)
        .some((f) => f.includes('absentRefs')));
});

// ---------------------------------------------------------------------------
// QB-59 — a packed third-party source keeps its declared capability
// ---------------------------------------------------------------------------

/**
 * Judges whether a declared dependency's published tarball would actually carry
 * the entry points this fixture imports.
 *
 * The consumer, not the producer, is where this failure is observable: the
 * producer's own boundary test can assert that `dist/v1/index.js` exists in its
 * working tree and still publish a tarball that omits `dist` entirely, at which
 * point every import in this fixture is unresolvable.
 */
export function censusPackedConsumerResolvability(packageJson, resolveExists) {
    const findings = [];
    const files = packageJson.files ?? [];
    const targets = new Set();
    for (const [subpath, condition] of Object.entries(packageJson.exports ?? {})) {
        const values = typeof condition === 'string' ? [condition] : Object.values(condition ?? {});
        for (const value of values) {
            if (typeof value === 'string') targets.add(`${subpath} ${value}`);
        }
    }
    if (targets.size === 0) return ['the dependency declares no export targets'];

    for (const entry of targets) {
        const [subpath, target] = entry.split(' ');
        const relative = target.replace(/^\.\//u, '');
        const root = relative.split('/')[0];
        if (!files.includes(root) && !files.includes(relative)) {
            findings.push(`${subpath} resolves to ${target}, which no 'files' entry publishes`);
        }
        if (!resolveExists(relative)) {
            findings.push(`${subpath} resolves to ${target}, which does not exist`);
        }
    }
    return findings;
}

test('QB-59: every entry point this fixture imports survives packing', () => {
    const dependencyRoot = join(repoRoot, 'packages', 'triage-protocol');
    const packageJson = JSON.parse(readFileSync(join(dependencyRoot, 'package.json'), 'utf8'));

    // The fixture's own declared dependency, not an arbitrary package.
    const declared = JSON.parse(readFileSync(join(fixtureRoot, 'package.json'), 'utf8'));
    assert.ok(Object.hasOwn(declared.dependencies, packageJson.name));

    assert.deepEqual(
        censusPackedConsumerResolvability(
            packageJson,
            (relative) => existsSync(join(dependencyRoot, relative)),
        ),
        [],
    );
});

test('QB-59: the census rejects an export map its own tarball would not carry', () => {
    const published = {
        exports: {
            '.': { types: './dist/index.d.ts', default: './dist/index.js' },
            './v1': { types: './dist/v1/index.d.ts', default: './dist/v1/index.js' },
        },
        // Wrong implementation: the producer publishes sources and README, and
        // its own boundary test still passes because `dist` exists locally.
        files: ['src', 'README.md', 'package.json'],
    };

    const findings = censusPackedConsumerResolvability(published, () => true);
    assert.equal(findings.length, 4);
    assert.ok(findings.every((finding) => finding.includes("no 'files' entry publishes")));

    // And the mirror failure: published, but absent from the tree it claims.
    assert.ok(censusPackedConsumerResolvability(
        { exports: { './v1': './dist/v1/index.js' }, files: ['dist'] },
        () => false,
    ).some((finding) => finding.includes('does not exist')));
});

/**
 * Judges whether a source's declared detail surface is one it actually ships.
 *
 * `checkTriageSourceContributionV1` admits a contribution whose
 * `surfaces.detail.renderer` names a renderer the same manifest never declares;
 * that shape resolves to nothing at mount, which is QB-04's "UI-time TypeError"
 * arriving through a route admission does not close. QB-59 requires a packed
 * third-party source to exercise its detail surface, so the fixture proves its
 * own artifact is self-consistent rather than assuming the checker did.
 */
export function censusShippedDetailSurface(manifest) {
    const findings = [];
    const declaredRenderers = new Set(
        (manifest.contributes?.ui?.renderers ?? []).map((renderer) => renderer.id),
    );
    const contributions = manifest.contributes?.targetedPluginContributions ?? [];
    if (contributions.length === 0) return ['the manifest declares no targeted contribution'];

    let detailSurfaces = 0;
    for (const contribution of contributions) {
        const renderer = contribution.surfaces?.detail?.renderer;
        if (renderer === undefined) continue;
        detailSurfaces += 1;
        if (!declaredRenderers.has(renderer)) {
            findings.push(`${contribution.id}: detail names renderer '${renderer}', which this manifest never ships`);
        }
    }
    if (detailSurfaces === 0) return ['no contribution declares a detail surface'];
    return findings;
}

test('QB-59: the shipped artifact ships the detail renderer its contribution names', () => {
    assert.deepEqual(censusShippedDetailSurface(shippedManifest), []);
});

test('QB-59: the census rejects a detail surface pointing at a renderer nobody ships', () => {
    const dangling = clone(shippedManifest);
    dangling.contributes.targetedPluginContributions[0].surfaces.detail.renderer = 'ledger-detials';

    assert.ok(censusShippedDetailSurface(dangling)
        .some((finding) => finding.includes('never ships')));

    // The other direction: the renderer is shipped but under a different owner's
    // id, so a manifest that shipped nothing at all is also rejected.
    const shipsNothing = clone(shippedManifest);
    shipsNothing.contributes.ui.renderers = [];
    assert.ok(censusShippedDetailSurface(shipsNothing)
        .some((finding) => finding.includes('never ships')));
});
