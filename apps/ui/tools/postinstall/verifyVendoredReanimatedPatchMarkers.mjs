import fs from 'node:fs';
import path from 'node:path';

/**
 * Integrity gate for the vendored `react-native-reanimated` settled-updates patch.
 *
 * WHY THIS EXISTS
 * The patch carries ONE behaviour hunk, and it fails SILENTLY when the hunk is lost: an animated
 * value gets stuck at a stale height/offset and no first-party test can observe it, because the
 * defect lives in a dependency's C++ reached through a native timer race. `patch-package`
 * regenerates a patch from whatever is in `node_modules` at the time, so a regeneration performed
 * against a partially-reverted tree drops hunks with no error and exit 0. That failure mode already
 * fired in this checkout: something re-ran `patch-package` mid-build.
 *
 * WHAT IT PROVES, AND WHY IT ASSERTS THE INSTALLED ARTIFACT
 * Asserting the `.patch` FILE's text is worthless — it reads the same whether or not the patch was
 * applied. This gate reads the installed `node_modules` sources instead: pure `fs`, no external
 * binary, same answer on every platform (Windows is first-class here, so `patch(1)` is not
 * available to us). It answers the only question that matters: "is the fix installed, and is it
 * live".
 *
 * "LIVE" is a real second question. The whole settled-updates mechanism — the defect AND the fix —
 * is inert unless the `FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS` static feature flag is on, because
 * that flag gates the `timestampMap_` write in `AnimatedPropsRegistry::update` inside an
 * `if constexpr`. With the flag off, nothing is ever timestamped, `getUpdatesOlderThanTimestamp`
 * matches nothing, and the call ordering this gate protects has no observable consequence. A future
 * flip of that flag would therefore silently retire the fix. It is checkable from first-party bytes,
 * so this gate checks it rather than merely documenting it — see {@link SETTLED_ANIMATIONS_FLAG}.
 *
 * LOUD ON UPSTREAM DRIFT
 * Every check fails rather than skips when the symbol, file, or flag it names is absent. An upstream
 * bump that renames `getSettledUpdates`, moves the registry write, or drops the flag must stop the
 * install so a human re-derives the fix, not quietly certify a tree that no longer contains it.
 */

/** Installed source that owns the report/remove ordering. */
export const REANIMATED_PROXY_SOURCE = 'Common/cpp/reanimated/NativeModules/ReanimatedModuleProxy.cpp';

/** Installed source that owns the `timestampMap_` write the flag gates. */
export const REANIMATED_REGISTRY_SOURCE = 'Common/cpp/reanimated/Fabric/updates/AnimatedPropsRegistry.cpp';

/**
 * Static feature-flag defaults shipped by the package. BOTH native build systems read this exact
 * file and then overlay the app's `package.json` — `scripts/reanimated_utils.rb#get_static_feature_flags`
 * for iOS (via `RNReanimated.podspec`) and `android/build.gradle#getReanimatedStaticFeatureFlags`
 * for Android — so resolving it the same way here reproduces the value the compiler will see.
 */
export const REANIMATED_STATIC_FLAGS_FILE = 'src/featureFlags/staticFlags.json';

/** The flag that decides whether the settled-updates mechanism exists at all in the built binary. */
export const SETTLED_ANIMATIONS_FLAG = 'FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS';

/** `ReanimatedModuleProxy::getSettledUpdates`, the function whose call order is the fix. */
const SETTLED_UPDATES_SIGNATURE = 'ReanimatedModuleProxy::getSettledUpdates(';

const REPORT_CALL = 'getUpdatesOlderThanTimestamp';
const REMOVE_CALL = 'removeUpdatesOlderThanTimestamp';

/**
 * One entry per check, with the provenance that lets a future reader decide whether it is still
 * needed. `removeWhen` is the condition under which the check should be DELETED rather than carried
 * forward — most likely because upstream fixed it.
 */
export const REANIMATED_PATCH_CHECKS = Object.freeze([
    {
        id: 'settled-updates-report-before-remove',
        file: REANIMATED_PROXY_SOURCE,
        defect: 'getSettledUpdates called removeUpdatesOlderThanTimestamp(now - 2000) BEFORE '
            + 'getUpdatesOlderThanTimestamp(now - 1000), so every entry that aged past the removal '
            + 'threshold since the previous call was erased without ever being reported. React never '
            + 'received it, the commit hook had nothing left to re-apply for that view, and '
            + "styleUpdater's shallowEqual skip meant the animation mapper never wrote it again — the "
            + 'loss is permanent. Reachable whenever the JS thread is starved for longer than the gap '
            + 'between the two thresholds, because PropsRegistryGarbageCollector drives this from a '
            + '500ms setInterval that coalesces under load. Device-proven: 0/16 in-band on the fixed '
            + 'build, 3/9 on a patch-REVERTED control built from the same toolchain (p = 0.0365), '
            + 'with the installed dylib disassembled to confirm the call order in machine code.',
        evidence: '.project/reviews/2026-08-09-toolchain-and-guard/',
        removeWhen: 'upstream reports settled updates before removing them, or stops draining the '
            + 'registry from the same call that reads it',
    },
    {
        id: 'settled-updates-age-thresholds',
        file: REANIMATED_PROXY_SOURCE,
        defect: 'The ordering fix is only correct while the REPORT age is not greater than the REMOVE '
            + 'age: an entry must be handed to React before it may be dropped. The patch names the two '
            + 'thresholds (kSettledReportAgeMs / kSettledRemoveAgeMs) and pins the relation with a '
            + 'static_assert, but that assert only fires during a NATIVE COMPILE — and this program '
            + 'was built on the discovery that the native gate had been silently skipped for two '
            + 'weeks. A tree with the calls in the right order and the ages swapped reproduces the '
            + 'original data loss and compiles nowhere until someone runs a full native build.',
        evidence: '.project/reviews/2026-08-09-toolchain-and-guard/',
        removeWhen: 'the ordering hunk no longer carries named age constants, i.e. upstream owns the '
            + 'relation itself',
    },
    {
        id: 'settled-animations-registry-gate',
        file: REANIMATED_REGISTRY_SOURCE,
        defect: 'AnimatedPropsRegistry::update writes timestampMap_ inside '
            + `if constexpr (StaticFeatureFlags::getFlag("${SETTLED_ANIMATIONS_FLAG}")). That write is `
            + 'the ONLY producer of the timestamps getUpdatesOlderThanTimestamp matches on, so it is '
            + 'the mechanism by which the flag decides whether the patched code path exists at all. '
            + 'This check is what gives settled-animations-flag-enabled its meaning: if upstream moves '
            + 'or ungates the write, the flag stops being the switch and the flag check becomes noise '
            + 'that must be re-derived rather than trusted.',
        evidence: '.project/reviews/2026-08-09-toolchain-and-guard/',
        removeWhen: 'upstream timestamps registry updates unconditionally, or the settled-updates '
            + 'mechanism stops depending on a static feature flag',
    },
    {
        id: 'settled-animations-flag-enabled',
        file: REANIMATED_STATIC_FLAGS_FILE,
        defect: `${SETTLED_ANIMATIONS_FLAG} is a compile-time flag: with it off, the timestampMap_ `
            + 'write is compiled out, getSettledUpdates can never match anything, and BOTH the defect '
            + 'and its fix become inert. It is currently true by package default with no app override, '
            + 'so the fix is live — but a future flip in either input would retire the patch silently '
            + 'and this gate would keep passing on ordering alone. Both native build systems resolve '
            + 'the flag from exactly these two inputs, so it is checkable rather than merely '
            + 'documentable. The flag NAME must also still exist: the C++ getFlag throws '
            + 'std::logic_error for an unrecognised name, so an upstream rename must fail here rather '
            + 'than at the far end of a native build.',
        evidence: '.project/reviews/2026-08-09-toolchain-and-guard/',
        removeWhen: 'upstream removes the flag and ships settled updates unconditionally, or this '
            + 'repository deliberately turns the mechanism off (in which case delete the patch too)',
    },
]);

/**
 * @param {Readonly<{ packageDir: string, appPackageJsonPath?: string }>} params
 * @returns {{ status: 'ok' | 'failed' | 'skipped', reason?: string, failures: Array<{ id: string, file: string, detail: string }> }}
 */
export function verifyVendoredReanimatedPatchMarkers(params) {
    const packageDir = params.packageDir;
    if (!fs.existsSync(packageDir)) {
        // Not installed (fresh clone, pruned install, or a workspace that does not depend on it).
        // Absence of the package is not a patch-integrity failure.
        return {
            status: 'skipped',
            reason: `package not installed at ${packageDir}`,
            failures: [],
        };
    }

    const failures = [];
    const fail = (id, detail) => {
        const check = REANIMATED_PATCH_CHECKS.find((candidate) => candidate.id === id);
        failures.push({ id, file: check ? check.file : '(unknown)', detail });
    };

    const proxySource = readInstalledSource(packageDir, REANIMATED_PROXY_SOURCE);
    if (proxySource === null) {
        // The package IS installed, so the source that owns the fix must be readable. Reporting `ok`
        // for a file the gate could not open is the exact vacuity this gate exists to replace.
        fail('settled-updates-report-before-remove', `${REANIMATED_PROXY_SOURCE} is not readable, so the fix could not be certified`);
        fail('settled-updates-age-thresholds', `${REANIMATED_PROXY_SOURCE} is not readable, so the age relation could not be certified`);
    } else {
        const body = extractFunctionBody(proxySource, SETTLED_UPDATES_SIGNATURE);
        if (body === null) {
            fail(
                'settled-updates-report-before-remove',
                `${SETTLED_UPDATES_SIGNATURE}) not found; upstream renamed or removed the function that owns the fix`,
            );
            fail('settled-updates-age-thresholds', 'the function that owns the age constants was not found');
        } else {
            checkCallOrdering(body, fail);
            checkAgeThresholds(body, fail);
        }
    }

    const registrySource = readInstalledSource(packageDir, REANIMATED_REGISTRY_SOURCE);
    if (registrySource === null) {
        fail('settled-animations-registry-gate', `${REANIMATED_REGISTRY_SOURCE} is not readable, so the flag's mechanism could not be certified`);
    } else if (!REGISTRY_GATE_PATTERN.test(registrySource)) {
        fail(
            'settled-animations-registry-gate',
            `no \`if constexpr (StaticFeatureFlags::getFlag("${SETTLED_ANIMATIONS_FLAG}"))\` gate found; `
            + 'the flag no longer decides whether settled updates are timestamped',
        );
    } else if (!registrySource.includes('timestampMap_')) {
        fail('settled-animations-registry-gate', 'the flag gate is present but no longer guards a `timestampMap_` write');
    }

    checkStaticFlag({ packageDir, appPackageJsonPath: params.appPackageJsonPath, fail });

    return failures.length > 0 ? { status: 'failed', failures } : { status: 'ok', failures: [] };
}

/** @param {ReturnType<typeof verifyVendoredReanimatedPatchMarkers>} result */
export function formatVendoredReanimatedPatchFailure(result) {
    const lines = ['Vendored react-native-reanimated settled-updates patch is not installed correctly:'];
    for (const failure of result.failures) {
        const check = REANIMATED_PATCH_CHECKS.find((candidate) => candidate.id === failure.id);
        lines.push(`  - ${failure.id} (${failure.file}): ${failure.detail}`);
        if (check) lines.push(`      ${check.defect}`);
        if (check) lines.push(`      evidence: ${check.evidence}`);
    }
    lines.push('');
    lines.push('This usually means the patch was regenerated against a partially-reverted node_modules,');
    lines.push('or an upstream bump moved the code the fix lives in.');
    lines.push('Do NOT hand-edit the .patch file. Restore the behaviour in node_modules, then run:');
    lines.push('  npx patch-package react-native-reanimated');
    return lines.join('\n');
}

const REGISTRY_GATE_PATTERN = new RegExp(
    `if\\s+constexpr\\s*\\(\\s*StaticFeatureFlags::getFlag\\(\\s*"${SETTLED_ANIMATIONS_FLAG}"\\s*\\)\\s*\\)`,
);

function readInstalledSource(packageDir, relativePath) {
    const filePath = path.join(packageDir, ...relativePath.split('/'));
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function checkCallOrdering(body, fail) {
    const reportIndex = body.indexOf(REPORT_CALL);
    const removeIndex = body.indexOf(REMOVE_CALL);

    if (reportIndex === -1 || removeIndex === -1) {
        const absent = [reportIndex === -1 ? REPORT_CALL : null, removeIndex === -1 ? REMOVE_CALL : null]
            .filter(Boolean)
            .join(' and ');
        fail(
            'settled-updates-report-before-remove',
            `getSettledUpdates no longer calls ${absent}; the ordering the fix establishes cannot be verified`,
        );
        return;
    }

    if (reportIndex > removeIndex) {
        fail(
            'settled-updates-report-before-remove',
            `${REMOVE_CALL} is called BEFORE ${REPORT_CALL}; settled updates are dropped before React sees them`,
        );
    }
}

function checkAgeThresholds(body, fail) {
    const reportAge = readNamedConstant(body, 'kSettledReportAgeMs');
    const removeAge = readNamedConstant(body, 'kSettledRemoveAgeMs');

    if (reportAge === null || removeAge === null) {
        const absent = [reportAge === null ? 'kSettledReportAgeMs' : null, removeAge === null ? 'kSettledRemoveAgeMs' : null]
            .filter(Boolean)
            .join(' and ');
        fail(
            'settled-updates-age-thresholds',
            `${absent} is missing from getSettledUpdates, so the hunk that names and pins the age relation is not installed`,
        );
        return;
    }

    if (reportAge > removeAge) {
        fail(
            'settled-updates-age-thresholds',
            `report age ${reportAge}ms exceeds remove age ${removeAge}ms; an entry can age out of the registry before it is ever reported`,
        );
    }
}

function readNamedConstant(body, name) {
    const match = new RegExp(`${name}\\s*=\\s*(-?[0-9]+(?:\\.[0-9]+)?)`).exec(body);
    return match ? Number(match[1]) : null;
}

function checkStaticFlag({ packageDir, appPackageJsonPath, fail }) {
    const flagsPath = path.join(packageDir, ...REANIMATED_STATIC_FLAGS_FILE.split('/'));
    let defaults;
    try {
        defaults = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
    } catch {
        fail('settled-animations-flag-enabled', `${REANIMATED_STATIC_FLAGS_FILE} is missing or unparseable, so the effective flag value is unknown`);
        return;
    }

    if (!Object.prototype.hasOwnProperty.call(defaults, SETTLED_ANIMATIONS_FLAG)) {
        fail(
            'settled-animations-flag-enabled',
            `${SETTLED_ANIMATIONS_FLAG} is no longer declared in ${REANIMATED_STATIC_FLAGS_FILE}; `
            + 'the C++ getFlag throws for an unrecognised name, so this must be re-derived rather than assumed',
        );
        return;
    }

    // Both build systems overlay the app's `package.json` on the package defaults and coerce every
    // value with `to_s`, matching only the literal `[NAME:true]`. Mirror that coercion exactly so
    // this gate cannot disagree with the compiler about what the flag resolves to.
    const override = readAppFlagOverride(appPackageJsonPath);
    const effective = override === undefined ? defaults[SETTLED_ANIMATIONS_FLAG] : override;
    if (String(effective) !== 'true') {
        const source = override === undefined ? REANIMATED_STATIC_FLAGS_FILE : `${appPackageJsonPath} (reanimated.staticFeatureFlags)`;
        fail(
            'settled-animations-flag-enabled',
            `${SETTLED_ANIMATIONS_FLAG} resolves to \`${String(effective)}\` from ${source}; `
            + 'the settled-updates mechanism is compiled out, so the vendored patch is dead code',
        );
    }
}

function readAppFlagOverride(appPackageJsonPath) {
    if (!appPackageJsonPath) return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(appPackageJsonPath, 'utf8'));
        const overrides = parsed?.reanimated?.staticFeatureFlags;
        if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, SETTLED_ANIMATIONS_FLAG)) {
            return undefined;
        }
        return overrides[SETTLED_ANIMATIONS_FLAG];
    } catch {
        return undefined;
    }
}

/**
 * Return the brace-delimited body that follows `signature`, or `null` when the signature is absent.
 *
 * Scoping to the function body is load-bearing rather than tidiness: a whole-file `indexOf` would
 * happily compare a call site in one function against a call site in another and report an ordering
 * that no single execution ever performs. String literals and comments are skipped while counting so
 * a future upstream brace inside either cannot desynchronise the walk — a desync fails LOUDLY (no
 * body found, or a truncated body missing the calls), never silently passes.
 */
function extractFunctionBody(contents, signature) {
    const signatureIndex = contents.indexOf(signature);
    if (signatureIndex === -1) return null;

    const openIndex = contents.indexOf('{', signatureIndex);
    if (openIndex === -1) return null;

    let depth = 0;
    for (let i = openIndex; i < contents.length; i += 1) {
        const char = contents[i];

        if (char === '/' && contents[i + 1] === '/') {
            const newline = contents.indexOf('\n', i);
            if (newline === -1) return null;
            i = newline;
            continue;
        }
        if (char === '/' && contents[i + 1] === '*') {
            const close = contents.indexOf('*/', i + 2);
            if (close === -1) return null;
            i = close + 1;
            continue;
        }
        if (char === '"' || char === "'") {
            const end = findLiteralEnd(contents, i, char);
            if (end === -1) return null;
            i = end;
            continue;
        }

        if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return contents.slice(openIndex + 1, i);
        }
    }
    return null;
}

function findLiteralEnd(contents, startIndex, quote) {
    for (let i = startIndex + 1; i < contents.length; i += 1) {
        if (contents[i] === '\\') {
            i += 1;
            continue;
        }
        if (contents[i] === quote) return i;
    }
    return -1;
}
