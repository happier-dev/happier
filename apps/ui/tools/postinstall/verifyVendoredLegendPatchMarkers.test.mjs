import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    LEGEND_PATCH_MARKERS,
    LEGEND_RUNTIME_BUILDS,
    formatVendoredLegendPatchFailure,
    verifyVendoredLegendPatchMarkers,
} from './verifyVendoredLegendPatchMarkers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Locate the package the way the runtime does. A hard-coded `apps/ui/node_modules` path is not
 * safe here: `@legendapp/list` is not in the workspace `nohoist` list, so its residence under the
 * app is incidental and a lockfile refresh may hoist it to the repository root. The only test that
 * touches REAL bytes skips when it cannot find the package, so a stale path would turn this whole
 * gate permanently green and silent — the same vacuity as `git apply --directory=node_modules`
 * printing "Skipped patch" and exiting 0.
 */
function resolveInstalledPackageDir() {
    try {
        // The package declares no root/`./package.json` export; `./react` is a published subpath.
        return path.dirname(createRequire(import.meta.url).resolve('@legendapp/list/react'));
    } catch {
        return path.join(UI_DIR, 'node_modules', '@legendapp', 'list');
    }
}

const INSTALLED_PACKAGE_DIR = resolveInstalledPackageDir();

/**
 * A stand-in package whose runtime builds contain every documented marker.
 *
 * Each marker is repeated to its own `minOccurrences`, and an entry scoped with `builds` is written
 * only into those builds — otherwise this generator would produce a package the real gate rejects,
 * and every test below would be measuring the generator instead of the gate.
 *
 * `omitMarkerFromBuilds` drops one marker from a SUBSET of builds, which is how the scoping rules
 * are shown to be load-bearing in both directions.
 */
function createFakePackage(options) {
    const omit = new Set(options?.omitMarkerIds ?? []);
    const onlyBuilds = options?.onlyBuilds ?? LEGEND_RUNTIME_BUILDS;
    const omitFrom = options?.omitMarkerFromBuilds;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legend-patch-markers-'));
    for (const build of onlyBuilds) {
        const body = LEGEND_PATCH_MARKERS
            .filter((entry) => !omit.has(entry.id))
            .filter((entry) => !entry.builds || entry.builds.includes(build))
            .filter((entry) => !(omitFrom?.id === entry.id && omitFrom.builds.includes(build)))
            .flatMap((entry) => Array.from({ length: entry.minOccurrences }, () => `// ${entry.marker}`))
            .join('\n');
        fs.writeFileSync(path.join(dir, build), `${body}\n`, 'utf8');
    }
    return dir;
}

test('reports ok when every documented marker is present in every runtime build', () => {
    const dir = createFakePackage();
    const result = verifyVendoredLegendPatchMarkers({ packageDir: dir });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.missingBuilds, []);
});

test('DISCRIMINATES: a single dropped hunk fails, and names the build and the defect', () => {
    // This is the failure mode the gate exists for: patch-package regenerated against a
    // partially-reverted tree silently drops a hunk.
    const dir = createFakePackage({ omitMarkerIds: ['ready-to-render-liveness'] });
    const result = verifyVendoredLegendPatchMarkers({ packageDir: dir });

    assert.equal(result.status, 'missing');
    // Every runtime build must report it — a hunk lost in one build is still a shipped defect.
    // This entry is unscoped, so "every build" is all six.
    assert.equal(result.missing.length, LEGEND_RUNTIME_BUILDS.length);
    for (const item of result.missing) {
        assert.equal(item.id, 'ready-to-render-liveness');
        assert.equal(item.found, 0);
    }

    const message = formatVendoredLegendPatchFailure(result);
    assert.match(message, /ready-to-render-liveness/);
    // The message must carry enough for a cold reader to act, not just a marker name.
    assert.match(message, /INVISIBLE/);
    assert.match(message, /patch-package @legendapp\/list/);
    assert.doesNotMatch(message, /hand-edit the \.patch file\.$/);
});

test('DISCRIMINATES: each documented marker is independently load-bearing', () => {
    // Guards against a marker string that is a substring of another, or an entry that can never fail.
    for (const entry of LEGEND_PATCH_MARKERS) {
        const dir = createFakePackage({ omitMarkerIds: [entry.id] });
        const result = verifyVendoredLegendPatchMarkers({ packageDir: dir });
        assert.equal(result.status, 'missing', `omitting ${entry.id} must fail the gate`);
        assert.ok(
            result.missing.every((item) => item.id === entry.id),
            `omitting ${entry.id} must not implicate another marker`,
        );
    }
});

test('DISCRIMINATES: a build-scoped hunk is required of its builds and only of those', () => {
    // Scoping is the one supported reason this gate may skip a check, so it has to be shown to be
    // load-bearing in BOTH directions: a scoped marker that vanishes from a build it applies to
    // must fail, and its absence from a build it does not apply to must not. A scope that only ever
    // suppresses failures is indistinguishable from deleting the entry.
    const scoped = LEGEND_PATCH_MARKERS.filter((entry) => entry.builds);
    assert.ok(scoped.length > 0, 'expected at least one build-scoped marker to exercise the rule');

    for (const entry of scoped) {
        const inScope = [...entry.builds];
        const outOfScope = LEGEND_RUNTIME_BUILDS.filter((build) => !inScope.includes(build));
        assert.ok(outOfScope.length > 0, `${entry.id} is scoped to every build; drop the scope`);

        const missingInScope = verifyVendoredLegendPatchMarkers({
            packageDir: createFakePackage({ omitMarkerFromBuilds: { builds: inScope, id: entry.id } }),
        });
        assert.equal(missingInScope.status, 'missing', `${entry.id} must be required of ${inScope.join(', ')}`);
        assert.deepEqual(
            missingInScope.missing.map((item) => item.build).sort(),
            [...inScope].sort(),
            `${entry.id} must be reported for exactly the builds it is scoped to`,
        );

        // The generator already omits it everywhere out of scope; the baseline package must be ok.
        const outOfScopeOk = verifyVendoredLegendPatchMarkers({ packageDir: createFakePackage() });
        assert.equal(
            outOfScopeOk.status,
            'ok',
            `${entry.id} must not be demanded of ${outOfScope.join(', ')}`,
        );
    }
});

test('skips rather than fails when the package is absent', () => {
    // A fresh clone or a pruned install is not a patch-integrity failure.
    const result = verifyVendoredLegendPatchMarkers({
        packageDir: path.join(os.tmpdir(), 'legend-patch-markers-does-not-exist'),
    });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.missing, []);
});

test('DISCRIMINATES: an installed package missing a runtime build cannot be certified', () => {
    // A build the gate cannot read is a build it cannot certify. Reporting `ok` for whatever
    // subset happens to exist is exactly the vacuity this gate replaced: it would certify one
    // file and stay silent about five shipped ones.
    const dir = createFakePackage({ onlyBuilds: ['react.js'] });
    const result = verifyVendoredLegendPatchMarkers({ packageDir: dir });

    assert.equal(result.status, 'missing');
    assert.deepEqual(
        result.missingBuilds,
        LEGEND_RUNTIME_BUILDS.filter((build) => build !== 'react.js'),
    );
    // The builds that ARE present still carry every marker, so no hunk may be reported missing.
    assert.deepEqual(result.missing, []);
    assert.match(formatVendoredLegendPatchFailure(result), /react-native\.web\.mjs/);
});

test('DISCRIMINATES: an installed package with no runtime build at all fails rather than skips', () => {
    // Upstream renaming its build outputs must fail LOUDLY so a human updates the build list —
    // a silent skip here turns the gate off for good while the hunks are genuinely gone.
    const dir = createFakePackage({ onlyBuilds: [] });
    const result = verifyVendoredLegendPatchMarkers({ packageDir: dir });
    assert.equal(result.status, 'missing');
    assert.deepEqual(result.missingBuilds, [...LEGEND_RUNTIME_BUILDS]);
});

test('no marker is a substring of another, so one hunk cannot mask another', () => {
    // Found the hard way: a first attempt to prove this gate on real bytes renamed
    // `mountedContainerId` to `mountedContainerIdX`, which still CONTAINS the marker, so the
    // substring search still matched and the gate reported a false pass. A marker that is a
    // substring of another marker would make that hole permanent.
    for (const outer of LEGEND_PATCH_MARKERS) {
        for (const inner of LEGEND_PATCH_MARKERS) {
            if (outer.id === inner.id) continue;
            assert.ok(
                !outer.marker.includes(inner.marker),
                `marker for ${outer.id} contains the marker for ${inner.id}; one hunk could mask the other`,
            );
        }
    }
});

test('every documented marker carries the provenance a future reader needs', () => {
    for (const entry of LEGEND_PATCH_MARKERS) {
        assert.ok(entry.defect.length > 80, `${entry.id} needs a real defect description`);
        assert.ok(entry.evidence.includes('.project/'), `${entry.id} needs an evidence pointer`);
        assert.ok(entry.removeWhen.length > 20, `${entry.id} needs a deletion condition`);
    }
});

test('the INSTALLED package still carries every hunk', (t) => {
    // The gate itself, against real bytes. Skips on a tree without the dependency installed.
    const result = verifyVendoredLegendPatchMarkers({ packageDir: INSTALLED_PACKAGE_DIR });
    if (result.status === 'skipped') {
        t.skip(result.reason);
        return;
    }
    assert.equal(result.status, 'ok', formatVendoredLegendPatchFailure(result));
});
