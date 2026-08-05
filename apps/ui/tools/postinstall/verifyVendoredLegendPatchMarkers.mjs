import fs from 'node:fs';
import path from 'node:path';

/**
 * Integrity gate for the vendored `@legendapp/list` patch.
 *
 * WHY THIS EXISTS
 * The patch carries five behaviour fixes for defects that fail SILENTLY when the hunk is lost —
 * one of them leaves the whole transcript permanently invisible. `patch-package` regenerates the
 * patch from whatever is in `node_modules` at the time, so a regeneration performed against a
 * partially-reverted tree drops hunks without any error. Nothing then fails until a user reports
 * the symptom.
 *
 * The check people reached for first — `git apply -R --check <patch> --directory=node_modules` —
 * is VACUOUS here: it resolves the patch's `node_modules/...` paths against the repo root, where
 * the package is not hoisted, so it prints "Skipped patch" for every file and exits 0 even for a
 * deliberately corrupted patch. `patch -p1 --dry-run -R` does discriminate, but `patch(1)` is not
 * reliably present on Windows, which this repository treats as first-class. So this gate asserts
 * the installed ARTIFACTS instead: pure `fs`, no external binary, same answer on every platform.
 *
 * WHAT IT PROVES
 * That each documented fix is present in every runtime build a consumer can resolve. It does not
 * re-verify hunk context; it answers the question that actually matters — "is the fix installed".
 */

/** Runtime builds a consumer can resolve. `.d.ts` files carry no behaviour and are excluded. */
export const LEGEND_RUNTIME_BUILDS = Object.freeze([
    'react-native.mjs',
    'react-native.js',
    'react-native.web.mjs',
    'react-native.web.js',
    'react.mjs',
    'react.js',
]);

/**
 * The builds Metro resolves for `@legendapp/list/react-native`, i.e. the ones that ship to iOS and
 * Android. They are a genuinely DIFFERENT implementation from the four web builds, not the same
 * source with branches: only these carry the `ignoreScrollFromMVCP` producer, the
 * `pendingNativeMVCPAdjust` state machine and the biased zero-size `ScrollAdjust` view. A fix for a
 * defect that exists only in this implementation therefore cannot be required of the web builds —
 * demanding it there would make the gate unsatisfiable, and satisfying it by patching web anyway
 * would ship dead code into the DOM renderer.
 */
export const LEGEND_NATIVE_RUNTIME_BUILDS = Object.freeze(['react-native.mjs', 'react-native.js']);

/**
 * One entry per behaviour hunk, with the provenance that lets a future reader decide whether it is
 * still needed. `removeWhen` is the condition under which the hunk should be DELETED rather than
 * carried forward — most likely because upstream fixed it.
 *
 * `builds` scopes an entry to a subset of {@link LEGEND_RUNTIME_BUILDS}; omit it for a fix that
 * belongs in every build.
 */
export const LEGEND_PATCH_MARKERS = Object.freeze([
    {
        id: 'position-suffix-shift',
        marker: 'positionShift',
        minOccurrences: 1,
        defect: 'updateItemPositions had one early exit (the breakAt guard) and it was the only path '
            + 'that skipped updateTotalSize, so position suffixes went stale while the incremental '
            + 'total stayed fresh. Live symptom: the transcript reserved 1184px past its last row and '
            + 'the viewport landed in the empty space.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w13/',
        removeWhen: 'upstream always reconciles positions and total in the same pass',
    },
    {
        id: 'ready-to-render-liveness',
        marker: 'mountedContainerId',
        minOccurrences: 1,
        defect: 'checkAllSizesKnown mutates (deletes sizesKnown) while applyItemSize drops '
            + 'needsRecalculate in exactly the !didContainersLayout case, so nothing re-runs the gate. '
            + 'didContainersLayout could stay false for the life of the mount, and because the row '
            + 'container is styled `opacity: readyToRender ? 1 : 0`, the whole transcript stayed '
            + 'INVISIBLE with its rows present in the DOM.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w20/',
        removeWhen: 'upstream schedules re-measurement when it invalidates a mounted row size',
    },
    {
        id: 'item-size-version-accounting',
        marker: 'previouslyContributedSize',
        minOccurrences: 1,
        defect: 'validateItemSizeVersion deleted a row size record without withdrawing its '
            + 'contribution to the incremental total, so the next setSize posted the full size on top '
            + 'of the un-withdrawn old one. Permanent when the row settles to exactly its estimate, '
            + 'because applyItemSize only recalculates on diff !== 0.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w16/',
        removeWhen: 'upstream pairs the delete with its decrement',
    },
    {
        id: 'render-range-beyond-content',
        marker: 'startBuffered === null && endBuffered === null',
        minOccurrences: 1,
        defect: 'When a scroll offset lands past every laid-out item, both range ends resolve null and '
            + 'calculateItemsInView writes no containers — then never recovers, because the next pass '
            + 'early-returns on !prevNumContainers. The mounted set freezes permanently.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w12/',
        removeWhen: 'upstream anchors the range when the probe falls beyond the last item',
    },
    {
        id: 'prefer-cached-size-refresh',
        marker: 'preferCachedSize = !doMVCP || state.scrollAdjustHandler',
        minOccurrences: 1,
        defect: 'dataChanged was part of the preferCachedSize term, and the dataChanged pass is the only '
            + 'one that walks from index 0 — so on an end-anchored list the entire scrollback stayed '
            + 'pinned at the estimate seed. Reproduced against the installed package: 200 rows of 26px '
            + 'reported 38156 end-anchored versus the exact 5200 top-anchored.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w10/',
        removeWhen: 'upstream refreshes estimates on the pass that walks from index 0',
    },
    {
        id: 'totalsize-stale-positions',
        marker: 'HAPPIER-TOTALSIZE-STALE-POSITIONS',
        minOccurrences: 1,
        defect: 'updateTotalSize published an ABSOLUTE content total computed from positions that '
            + 'described a different, longer data array. `state.props` is mutated during render, so '
            + 'any event-driven pass running before the reconciling dataChanged pass sees new data '
            + 'against the old position model; when the data is shorter, updateItemPositions walks '
            + 'no rows (startIndex is already past the end) and the total published is '
            + '`positions[data.length - 1] + size`. With a one-row data that is `positions[0]` (0) '
            + 'plus an unknown row size, i.e. exactly `estimatedItemSize`. This makes the shrink '
            + 'direction symmetric with the grow direction, which Legend already refuses via the '
            + '`lastPosition !== void 0` guard. SCOPE, stated because it was originally overclaimed: '
            + 'this hunk is a library invariant reproduced against a synthetic stale-model shape '
            + '(legendStalePositionsContentSize.fabric.native.real.integration.test.tsx). It is NOT '
            + 'the producer of the measured send-crossover blank - its precondition '
            + '(positions.length > data.length) occurred 0 times in 369 recorded device calls over '
            + '12 instrumented trials, and updateTotalSize was measured RESTORING the correct total '
            + 'rather than writing the collapsed one. That defect is the null-key sentinel collision '
            + 'documented under absolute-total-sentinel / null-item-key-no-size below.',
        evidence: '.project/reviews/2026-08-01-send-transition/U1-totalsize-producer.md, refuted as '
            + 'the device producer by U3-validation.md §3 and re-derived from installed bytes in '
            + 'U4-close.md §1.1',
        removeWhen: 'upstream reconciles the position model before publishing an absolute total, or '
            + 'stops mutating state.props during render so props.data can never lead the model',
    },
    {
        id: 'absolute-total-sentinel',
        marker: 'HAPPIER_TOTAL_SIZE_ABSOLUTE',
        // One declaration, one comparison in addTotalSize, and the four intentional absolute-write
        // call sites. A regeneration that kept the comparison but lost the call sites would leave a
        // sentinel nobody passes, i.e. no absolute write at all, so all six must be present.
        minOccurrences: 6,
        defect: 'addTotalSize overloaded `key === null` as its ABSOLUTE-WRITE sentinel ("this number '
            + 'IS the total") while getId returns `null` for any index past the end of `data` '
            + '("there is no such row"). Two meanings, one value. A probe of a row the current data '
            + 'no longer contains therefore assigned the whole content size to be one unmeasured '
            + 'row: getId -> null -> getItemSize falls through to estimatedItemSize -> setSize with '
            + 'a null key -> addTotalSize with a null key -> totalSize = estimatedItemSize, written '
            + 'absolutely. MEASURED on device with a 4/4 identical stack (checkResetContainers -> '
            + 'calculateItemsInView -> prepareMVCP\'s closure -> getItemSize(ctx, getId(state, '
            + 'scrollingTo.index), ...), where the pinned index outlived the row it addressed): '
            + 'totalSize 2,322 -> 240 on a 43-row transcript AND 266,020 -> 240 on a 419-row one, '
            + 'the SAME constant rather than a sum, then alignItemsAtEndPadding grown to 297 '
            + '(12 + 142 + 240 + 297 = 691, the viewport, to the pixel) and UIScrollView clamping '
            + 'contentOffset to that one-viewport content - the transcript going blank on send. '
            + 'The sentinel now has a private value no item key can take, so the ambiguity is gone '
            + 'rather than blocked at one caller. Validated by a randomised interleaved '
            + 'within-session device A/B: collapse, visible blank and teleport all 16/16 defect vs '
            + '0/16 fixed (Fisher p = 3.3e-9), with the app-side trigger firing in both arms.',
        evidence: '.project/reviews/2026-08-01-send-transition/S1-sentinel-fix.md (producer named '
            + 'in U3-validation.md §3, re-derived from installed bytes in U4-close.md §1.1, device '
            + 'A/B in S2-ab-validation.md)',
        removeWhen: 'upstream stops representing "no such row" and "write this total absolutely" '
            + 'with the same value - e.g. it splits the absolute write into its own function or '
            + 'gives the sentinel a private identity of its own',
    },
    {
        id: 'null-item-key-no-size',
        marker: 'HAPPIER-NULLKEY-NO-ROW-NO-SIZE',
        minOccurrences: 1,
        defect: 'setSize accepted `null` as an item key, so a row that does not exist could record a '
            + 'size and contribute it to the running content total. Around fifteen call sites hand a '
            + 'getId result straight to getItemSize with no null check, and the MEASURED device '
            + 'stack goes through prepareMVCP\'s closure rather than getItemSizeAtIndex, so guarding '
            + 'any single caller would not have covered it. setSize is the one choke point every '
            + 'resolved size passes. Paired with absolute-total-sentinel: that entry removes the '
            + 'two-meanings-one-value ambiguity, this one removes the phantom contribution the '
            + 'disambiguation would otherwise leave behind (MEASURED in the fabric lane: an emptied '
            + 'list published 240 instead of 0 until this guard landed).',
        evidence: '.project/reviews/2026-08-01-send-transition/S1-sentinel-fix.md and '
            + 'S2-ab-validation.md (a null key entered `sizes` on 16/16 defect-arm trials and '
            + '0/33 fixed-arm trials)',
        removeWhen: 'upstream rejects a non-item key at the size model boundary, or getId stops '
            + 'returning a value that reads as a key for an index it has no row for',
    },
    {
        id: 'mvcp-anchor-lock-native',
        marker: 'HAPPIER-MVCP-ANCHOR-LOCK-NATIVE',
        // Producer (updateAnchorLock) and consumer (prepareMVCP's resolveAnchorLock call) were
        // gated separately. Either one surviving alone is a silent no-op, so both must be present.
        minOccurrences: 2,
        builds: LEGEND_NATIVE_RUNTIME_BUILDS,
        defect: 'updateAnchorLock had its entire body wrapped in `Platform.OS === "web"` and '
            + 'prepareMVCP resolved the lock as `isWeb ? resolveAnchorLock(...) : void 0`, so '
            + 'state.mvcpAnchorLock was never written and never read on native. Native therefore '
            + 're-picked its MVCP anchor out of idsInView on every pass with no identity or position '
            + 'continuity across a data change - the exact shape of a message-send crossover, where '
            + 'a row is removed and another inserted at the same place in two separate passes. '
            + 'Nothing in the lock is web-specific: it reads props and indexByKey and writes state.',
        evidence: '.project/reviews/2026-08-01-send-transition/Q1-native-mvcp.md',
        removeWhen: 'upstream ships the anchor lock unconditionally, or replaces it with a '
            + 'cross-platform anchor identity mechanism',
    },
    {
        id: 'mvcp-ignore-resolves-pending',
        marker: 'HAPPIER-MVCP-IGNORE-RESOLVES-PENDING',
        minOccurrences: 1,
        builds: LEGEND_NATIVE_RUNTIME_BUILDS,
        defect: 'updateScroll called resolvePendingNativeMVCPAdjust BELOW the ignoreScrollFromMVCP '
            + 'early return, while arming a pendingNativeMVCPAdjust is itself what arms that band. '
            + 'The adjust therefore blinded the only channel that can retire it, and while it '
            + 'survives native turns off render-range projection, user-scroll detection, the '
            + 'large-jump escape hatch, every subsequent MVCP pass and doMaintainScrollAtEnd. '
            + 'Measured: the pending adjust stayed armed through the whole suppression window.',
        evidence: '.project/reviews/2026-08-01-send-transition/Q1-native-mvcp.md',
        removeWhen: 'upstream resolves the pending native adjust before consulting the ignore band, '
            + 'or drops the pending-adjust state machine',
    },
    {
        id: 'mvcp-ignore-defers-observation',
        marker: 'ignoreScrollFromMVCPDeferredScroll',
        // Set on rejection, cleared on acceptance, cleared when a new adjust arms, and read plus
        // cleared by the expiry timer. Any one of those going missing breaks the hand-off.
        minOccurrences: 5,
        builds: LEGEND_NATIVE_RUNTIME_BUILDS,
        defect: 'A scroll observation the ignore band rejected was DESTROYED, not deferred: only the '
            + 'boolean ignoreScrollFromMVCPIgnored survived, and the expiry timer then reprocessed '
            + 'state.scroll - the open-loop prediction this build verifies against nothing, since it '
            + 'reads the real scroll offset nowhere. The observed offset could never be learned. '
            + 'Storing the rejected offset and reprocessing THAT changes no timer duration; it turns '
            + 'the window from "destroy reality" into "delay reality".',
        evidence: '.project/reviews/2026-08-01-send-transition/Q1-native-mvcp.md',
        removeWhen: 'upstream gives the native build a real scroll-offset read, making the '
            + 'prediction reconcilable without deferring observations',
    },
    {
        id: 'mvcp-ignore-band-direction',
        marker: 'state.ignoreScrollFromMVCP.lt = void 0',
        minOccurrences: 1,
        builds: LEGEND_NATIVE_RUNTIME_BUILDS,
        defect: 'state.ignoreScrollFromMVCP is one REUSED object, and an adjust wrote only the bound '
            + 'for its own direction, so an earlier opposite-direction adjust left its stale bound in '
            + 'place. The accept set then became the interval [lt, gt] with nothing enforcing '
            + 'lt <= gt - measured collapsing to a SINGLE acceptable offset (lt === gt === 2100) on '
            + 'a 4000px list after a two-pass insert+delete, and empty outright when the bounds '
            + 'cross. Every observation outside that slit was rejected and destroyed.',
        evidence: '.project/reviews/2026-08-01-send-transition/Q1-native-mvcp.md',
        removeWhen: 'upstream derives the band from the net adjust, or replaces the shared threshold '
            + 'object with a per-adjust record',
    },
]);

/**
 * @param {Readonly<{ packageDir: string }>} params
 * @returns {{ status: 'ok' | 'missing' | 'skipped', reason?: string, missing: Array<{ build: string, id: string, marker: string, found: number, expected: number }>, missingBuilds: string[] }}
 */
export function verifyVendoredLegendPatchMarkers(params) {
    const packageDir = params.packageDir;
    if (!fs.existsSync(packageDir)) {
        // Not installed (fresh clone, pruned install, or a workspace that does not depend on it).
        // Absence of the package is not a patch-integrity failure.
        return {
            status: 'skipped',
            reason: `package not installed at ${packageDir}`,
            missing: [],
            missingBuilds: [],
        };
    }

    const missing = [];
    const missingBuilds = [];

    for (const build of LEGEND_RUNTIME_BUILDS) {
        const buildPath = path.join(packageDir, build);
        if (!fs.existsSync(buildPath)) {
            // The package IS installed, so every runtime build it ships must be readable here. A
            // build the gate cannot read is a build it cannot certify, and answering `ok` for the
            // surviving subset would reproduce the exact vacuity this gate replaced — a check that
            // silently skips what it was asked to verify and still exits 0. Upstream renaming its
            // build outputs must fail loudly so a human updates LEGEND_RUNTIME_BUILDS.
            missingBuilds.push(build);
            continue;
        }
        const contents = fs.readFileSync(buildPath, 'utf8');
        for (const entry of LEGEND_PATCH_MARKERS) {
            // A hunk scoped to a subset of builds is not expected in the others. This is the only
            // supported reason to skip a check, and it is declared per entry rather than inferred,
            // so "not found" can never be silently reinterpreted as "not applicable".
            if (entry.builds && !entry.builds.includes(build)) {
                continue;
            }
            const found = countOccurrences(contents, entry.marker);
            if (found < entry.minOccurrences) {
                missing.push({
                    build,
                    id: entry.id,
                    marker: entry.marker,
                    found,
                    expected: entry.minOccurrences,
                });
            }
        }
    }

    return missing.length > 0 || missingBuilds.length > 0
        ? { status: 'missing', missing, missingBuilds }
        : { status: 'ok', missing: [], missingBuilds: [] };
}

/** @param {ReturnType<typeof verifyVendoredLegendPatchMarkers>} result */
export function formatVendoredLegendPatchFailure(result) {
    const lines = ['Vendored @legendapp/list patch is missing behaviour hunks:'];
    for (const build of result.missingBuilds ?? []) {
        lines.push(`  - ${build}: runtime build absent, so its hunks could not be certified`);
    }
    for (const item of result.missing) {
        const entry = LEGEND_PATCH_MARKERS.find((candidate) => candidate.id === item.id);
        lines.push(`  - ${item.build}: ${item.id} (found ${item.found}, expected >= ${item.expected})`);
        if (entry) lines.push(`      ${entry.defect}`);
        if (entry) lines.push(`      evidence: ${entry.evidence}`);
    }
    lines.push('');
    lines.push('This usually means the patch was regenerated against a partially-reverted node_modules.');
    lines.push('Do NOT hand-edit the .patch file. Restore the behaviour in node_modules, then run:');
    lines.push('  npx patch-package @legendapp/list');
    return lines.join('\n');
}

function countOccurrences(haystack, needle) {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
