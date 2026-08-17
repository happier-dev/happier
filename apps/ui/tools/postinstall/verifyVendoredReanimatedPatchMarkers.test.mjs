import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    REANIMATED_PATCH_CHECKS,
    REANIMATED_PROXY_SOURCE,
    REANIMATED_REGISTRY_SOURCE,
    REANIMATED_STATIC_FLAGS_FILE,
    SETTLED_ANIMATIONS_FLAG,
    formatVendoredReanimatedPatchFailure,
    verifyVendoredReanimatedPatchMarkers,
} from './verifyVendoredReanimatedPatchMarkers.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Locate the package the way the runtime does rather than hard-coding `apps/ui/node_modules`: a
 * lockfile refresh may hoist it to the repository root, and the only test that touches REAL bytes
 * skips when it cannot find the package — so a stale path would turn this whole gate permanently
 * green and silent.
 */
function resolveInstalledPackageDir() {
    try {
        return path.dirname(createRequire(import.meta.url).resolve('react-native-reanimated/package.json'));
    } catch {
        return path.join(UI_DIR, 'node_modules', 'react-native-reanimated');
    }
}

const INSTALLED_PACKAGE_DIR = resolveInstalledPackageDir();

const CORRECT_PROXY_BODY = `
jsi::Value ReanimatedModuleProxy::getSettledUpdates(jsi::Runtime &rt) {
  react_native_assert(
      StaticFeatureFlags::getFlag("${SETTLED_ANIMATIONS_FLAG}") &&
      "getSettledUpdates requires ${SETTLED_ANIMATIONS_FLAG} static feature flag to be enabled");

  const auto currentTimestamp = getAnimationTimestamp_();
  const auto lock = animatedPropsRegistry_->lock();

  constexpr double kSettledReportAgeMs = 1000;
  constexpr double kSettledRemoveAgeMs = 2000;
  static_assert(
      kSettledRemoveAgeMs >= kSettledReportAgeMs,
      "Updates must be reported to React before they can be removed from the registry");

  auto settledUpdates = animatedPropsRegistry_->getUpdatesOlderThanTimestamp(rt, currentTimestamp - kSettledReportAgeMs);

  animatedPropsRegistry_->removeUpdatesOlderThanTimestamp(currentTimestamp - kSettledRemoveAgeMs);

  return settledUpdates;
}
`;

const CORRECT_REGISTRY_BODY = `
void AnimatedPropsRegistry::update(jsi::Runtime &rt, const jsi::Value &operations, const double timestamp) {
  for (size_t i = 0; i < length; ++i) {
    if constexpr (StaticFeatureFlags::getFlag("${SETTLED_ANIMATIONS_FLAG}")) {
      timestampMap_[shadowNode->getTag()] = timestamp;
    }
  }
}
`;

/**
 * A stand-in installed package. Every source starts from bytes that mirror the real patched tree, so
 * a test that mutates one of them is measuring the gate rather than the generator.
 */
function createFakePackage(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reanimated-patch-markers-'));
    const write = (relativePath, contents) => {
        const filePath = path.join(dir, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, 'utf8');
    };

    if (!options.omitFiles?.includes(REANIMATED_PROXY_SOURCE)) {
        write(REANIMATED_PROXY_SOURCE, options.proxySource ?? CORRECT_PROXY_BODY);
    }
    if (!options.omitFiles?.includes(REANIMATED_REGISTRY_SOURCE)) {
        write(REANIMATED_REGISTRY_SOURCE, options.registrySource ?? CORRECT_REGISTRY_BODY);
    }
    if (!options.omitFiles?.includes(REANIMATED_STATIC_FLAGS_FILE)) {
        write(REANIMATED_STATIC_FLAGS_FILE, JSON.stringify(options.staticFlags ?? {
            USE_SYNCHRONIZABLE_FOR_MUTABLES: true,
            [SETTLED_ANIMATIONS_FLAG]: true,
        }, null, 2));
    }
    return dir;
}

function createAppPackageJson(reanimatedSection) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reanimated-app-pkg-'));
    const filePath = path.join(dir, 'package.json');
    fs.writeFileSync(filePath, JSON.stringify({ name: 'happy', ...(reanimatedSection ? { reanimated: reanimatedSection } : {}) }), 'utf8');
    return filePath;
}

function idsOf(result) {
    return result.failures.map((failure) => failure.id).sort();
}

test('reports ok when the fix is installed and the flag that makes it live is on', () => {
    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage() });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.failures, []);
});

test('DISCRIMINATES: the exact defect — remove called before report — fails and names the consequence', () => {
    // This is the whole reason the gate exists. `patch-package` regenerated against a
    // partially-reverted tree restores upstream's order with no error and exit 0.
    const reverted = CORRECT_PROXY_BODY
        .replace(
            '  auto settledUpdates = animatedPropsRegistry_->getUpdatesOlderThanTimestamp(rt, currentTimestamp - kSettledReportAgeMs);\n\n'
            + '  animatedPropsRegistry_->removeUpdatesOlderThanTimestamp(currentTimestamp - kSettledRemoveAgeMs);\n',
            '  animatedPropsRegistry_->removeUpdatesOlderThanTimestamp(currentTimestamp - kSettledRemoveAgeMs);\n\n'
            + '  auto settledUpdates = animatedPropsRegistry_->getUpdatesOlderThanTimestamp(rt, currentTimestamp - kSettledReportAgeMs);\n',
        );
    assert.notEqual(reverted, CORRECT_PROXY_BODY, 'the mutation must actually change the bytes');

    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ proxySource: reverted }) });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-updates-report-before-remove']);

    const message = formatVendoredReanimatedPatchFailure(result);
    assert.match(message, /removeUpdatesOlderThanTimestamp is called BEFORE getUpdatesOlderThanTimestamp/);
    // A cold reader must get the consequence and the recovery command, not just a symbol name.
    assert.match(message, /permanent/);
    assert.match(message, /patch-package react-native-reanimated/);
});

test('DISCRIMINATES: the ordering hunk disappearing entirely fails', () => {
    // The upstream body has the two calls in the wrong order AND no named constants at all.
    const upstream = `
jsi::Value ReanimatedModuleProxy::getSettledUpdates(jsi::Runtime &rt) {
  const auto currentTimestamp = getAnimationTimestamp_();
  const auto lock = animatedPropsRegistry_->lock();
  animatedPropsRegistry_->removeUpdatesOlderThanTimestamp(currentTimestamp - 2000);
  return animatedPropsRegistry_->getUpdatesOlderThanTimestamp(rt, currentTimestamp - 1000);
}
`;
    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ proxySource: upstream }) });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-updates-age-thresholds', 'settled-updates-report-before-remove']);
});

test('DISCRIMINATES: right order, swapped ages still fails', () => {
    // A tree in this state reproduces the original data loss and compiles nowhere until someone runs
    // a full native build — which is precisely the gate this program found had been skipped.
    const swapped = CORRECT_PROXY_BODY
        .replace('kSettledReportAgeMs = 1000', 'kSettledReportAgeMs = 3000');
    assert.notEqual(swapped, CORRECT_PROXY_BODY, 'the mutation must actually change the bytes');

    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ proxySource: swapped }) });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-updates-age-thresholds']);
    assert.match(formatVendoredReanimatedPatchFailure(result), /report age 3000ms exceeds remove age 2000ms/);
});

test('DISCRIMINATES: an upstream rename of getSettledUpdates fails LOUDLY rather than passing', () => {
    // The failure mode a marker gate must never have: the symbol it certifies is gone, so it has
    // nothing to check, and "nothing to check" reads as "nothing wrong".
    const renamed = CORRECT_PROXY_BODY.replaceAll('getSettledUpdates', 'drainSettledUpdates');
    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ proxySource: renamed }) });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-updates-age-thresholds', 'settled-updates-report-before-remove']);
    assert.match(formatVendoredReanimatedPatchFailure(result), /renamed or removed/);
});

test('DISCRIMINATES: the ordering is read from inside getSettledUpdates, not from the file at large', () => {
    // A whole-file indexOf would compare a call site in one function against a call site in another
    // and certify an ordering no single execution ever performs. Here a DECOY function above the
    // real one has the calls in the correct order while getSettledUpdates itself is reverted.
    const decoy = `
jsi::Value ReanimatedModuleProxy::flushEverything(jsi::Runtime &rt) {
  auto kept = animatedPropsRegistry_->getUpdatesOlderThanTimestamp(rt, 0);
  animatedPropsRegistry_->removeUpdatesOlderThanTimestamp(0);
  return kept;
}

jsi::Value ReanimatedModuleProxy::getSettledUpdates(jsi::Runtime &rt) {
  constexpr double kSettledReportAgeMs = 1000;
  constexpr double kSettledRemoveAgeMs = 2000;
  animatedPropsRegistry_->removeUpdatesOlderThanTimestamp(currentTimestamp - kSettledRemoveAgeMs);
  return animatedPropsRegistry_->getUpdatesOlderThanTimestamp(rt, currentTimestamp - kSettledReportAgeMs);
}
`;
    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ proxySource: decoy }) });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-updates-report-before-remove']);
});

test('DISCRIMINATES: braces inside comments and string literals do not desynchronise the body walk', () => {
    // The body must still be found (and still be certified) when upstream adds a brace to a comment
    // or a message string; a desync here would fail loudly, which is safe but would be a false alarm.
    const noisy = CORRECT_PROXY_BODY.replace(
        '  const auto currentTimestamp = getAnimationTimestamp_();',
        '  // upstream note: the map is keyed { tag -> timestamp }\n'
        + '  const std::string hint = "unbalanced { brace in a literal";\n'
        + '  const auto currentTimestamp = getAnimationTimestamp_();',
    );
    assert.notEqual(noisy, CORRECT_PROXY_BODY, 'the mutation must actually change the bytes');
    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ proxySource: noisy }) });
    assert.equal(result.status, 'ok', formatVendoredReanimatedPatchFailure(result));
});

test('DISCRIMINATES: losing the registry flag gate fails, because that gate is why the flag matters', () => {
    const ungated = CORRECT_REGISTRY_BODY.replace(
        `if constexpr (StaticFeatureFlags::getFlag("${SETTLED_ANIMATIONS_FLAG}")) {`,
        'if (true) {',
    );
    assert.notEqual(ungated, CORRECT_REGISTRY_BODY, 'the mutation must actually change the bytes');

    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ registrySource: ungated }) });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-animations-registry-gate']);
});

test('DISCRIMINATES: the gate surviving without its timestampMap_ write still fails', () => {
    const hollow = CORRECT_REGISTRY_BODY.replace('timestampMap_[shadowNode->getTag()] = timestamp;', 'recordUpdate(shadowNode);');
    const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ registrySource: hollow }) });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-animations-registry-gate']);
});

test('DISCRIMINATES: the flag turned off in the package defaults fails, because the fix becomes dead code', () => {
    const result = verifyVendoredReanimatedPatchMarkers({
        packageDir: createFakePackage({ staticFlags: { [SETTLED_ANIMATIONS_FLAG]: false } }),
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-animations-flag-enabled']);
    assert.match(formatVendoredReanimatedPatchFailure(result), /resolves to `false`/);
});

test('DISCRIMINATES: an app package.json override is read the way the native builds read it', () => {
    // Both `scripts/reanimated_utils.rb` and `android/build.gradle` overlay the app's package.json on
    // the package defaults, so an override there — in EITHER direction — is what the compiler sees.
    const packageDir = createFakePackage();
    const disabled = verifyVendoredReanimatedPatchMarkers({
        packageDir,
        appPackageJsonPath: createAppPackageJson({ staticFeatureFlags: { [SETTLED_ANIMATIONS_FLAG]: false } }),
    });
    assert.equal(disabled.status, 'failed');
    assert.deepEqual(idsOf(disabled), ['settled-animations-flag-enabled']);
    assert.match(formatVendoredReanimatedPatchFailure(disabled), /reanimated\.staticFeatureFlags/);

    // An override that restores the flag over a `false` package default must PASS, otherwise the
    // overlay is only ever able to fail the gate and is indistinguishable from ignoring it.
    const rescued = verifyVendoredReanimatedPatchMarkers({
        packageDir: createFakePackage({ staticFlags: { [SETTLED_ANIMATIONS_FLAG]: false } }),
        appPackageJsonPath: createAppPackageJson({ staticFeatureFlags: { [SETTLED_ANIMATIONS_FLAG]: true } }),
    });
    assert.equal(rescued.status, 'ok', formatVendoredReanimatedPatchFailure(rescued));

    // An unrelated override must not be mistaken for this one.
    const untouched = verifyVendoredReanimatedPatchMarkers({
        packageDir,
        appPackageJsonPath: createAppPackageJson({ staticFeatureFlags: { RUNTIME_TEST_FLAG: false } }),
    });
    assert.equal(untouched.status, 'ok', formatVendoredReanimatedPatchFailure(untouched));
});

test('DISCRIMINATES: an upstream rename of the flag fails rather than defaulting to enabled', () => {
    // The C++ `getFlag` throws `std::logic_error` for an unrecognised name, so a rename is a
    // build-breaking change that must be re-derived here, not absorbed silently.
    const result = verifyVendoredReanimatedPatchMarkers({
        packageDir: createFakePackage({ staticFlags: { FORCE_REACT_RENDER_FOR_SETTLED_UPDATES: true } }),
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(idsOf(result), ['settled-animations-flag-enabled']);
    assert.match(formatVendoredReanimatedPatchFailure(result), /no longer declared/);
});

test('skips rather than fails when the package is absent', () => {
    // A fresh clone or a pruned install is not a patch-integrity failure.
    const result = verifyVendoredReanimatedPatchMarkers({
        packageDir: path.join(os.tmpdir(), 'reanimated-patch-markers-does-not-exist'),
    });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.failures, []);
});

test('DISCRIMINATES: an installed package missing a source it needs fails rather than skips', () => {
    // A file the gate cannot read is a file it cannot certify. Reporting `ok` for whatever subset
    // happens to exist is the exact vacuity this gate replaced.
    for (const omitted of [REANIMATED_PROXY_SOURCE, REANIMATED_REGISTRY_SOURCE, REANIMATED_STATIC_FLAGS_FILE]) {
        const result = verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ omitFiles: [omitted] }) });
        assert.equal(result.status, 'failed', `omitting ${omitted} must fail the gate`);
        assert.ok(
            result.failures.every((failure) => failure.file === omitted),
            `omitting ${omitted} must not implicate another source`,
        );
    }
});

test('every documented check carries the provenance a future reader needs', () => {
    for (const check of REANIMATED_PATCH_CHECKS) {
        assert.ok(check.defect.length > 80, `${check.id} needs a real defect description`);
        assert.ok(check.evidence.includes('.project/'), `${check.id} needs an evidence pointer`);
        assert.ok(check.removeWhen.length > 20, `${check.id} needs a deletion condition`);
    }
});

test('every check id can actually be emitted, so no entry is decorative', () => {
    // A check documented but never reachable is worse than no check: it reads as coverage.
    const emitted = new Set();
    const collect = (result) => result.failures.forEach((failure) => emitted.add(failure.id));
    collect(verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ proxySource: CORRECT_PROXY_BODY.replaceAll('getSettledUpdates', 'x') }) }));
    collect(verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ registrySource: 'void update() {}' }) }));
    collect(verifyVendoredReanimatedPatchMarkers({ packageDir: createFakePackage({ staticFlags: {} }) }));
    assert.deepEqual([...emitted].sort(), REANIMATED_PATCH_CHECKS.map((check) => check.id).sort());
});

test('the INSTALLED package still carries the fix, and the flag that makes it live is still on', (t) => {
    // The gate itself, against real bytes. Skips on a tree without the dependency installed.
    const result = verifyVendoredReanimatedPatchMarkers({
        packageDir: INSTALLED_PACKAGE_DIR,
        appPackageJsonPath: path.join(UI_DIR, 'package.json'),
    });
    if (result.status === 'skipped') {
        t.skip(result.reason);
        return;
    }
    assert.equal(result.status, 'ok', formatVendoredReanimatedPatchFailure(result));
});
