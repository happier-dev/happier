import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * G1 — viewport seam boundary fitness function (read + write side, ported from remote-dev).
 *
 * The transcript host (`ChatList.tsx`) must hold NO raw native scroll READ, NO inline raw orientation MAPPING,
 * and NO raw scroll WRITE: the guarded raw native-offset READ lives behind `readNativeAbsoluteScrollOffset`,
 * the raw offset → canonical mapping lives behind the fact source `toCanonicalOffset` (host helper
 * `resolveCanonicalScrollOffset`), and every raw scroll WRITE (`scrollToIndex` / `scrollToOffset` /
 * `scrollToEnd` / `element.scrollTop=`) lives behind `performTranscriptViewportCommand`, never inlined in the
 * 10k-line host. This guards against a future regression silently re-introducing the raw-`0` / `isTrusted`
 * confusion classes by re-adding a raw call to the host. The repo has no eslint config for `apps/ui`, so this
 * source-level assertion is the canonical enforcement of the boundary.
 *
 * If this fails because a raw primitive was legitimately added at the seam boundary itself, route it through
 * the owning module (the read helper / the fact source / the command writer) rather than relaxing the test.
 */
const CHATLIST = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const CHAIN_TRANSCRIPT_LIST = readFileSync(new URL('./ChainTranscriptList.tsx', import.meta.url), 'utf8');
const COMMAND_WRITER = readFileSync(
    new URL('./viewport/performTranscriptViewportCommand.ts', import.meta.url),
    'utf8',
);
const VIEWPORT_TYPES = readFileSync(
    new URL('./viewport/transcriptViewportTypes.ts', import.meta.url),
    'utf8',
);
const LIST_ORIENTATION = readFileSync(new URL('./listOrientation.ts', import.meta.url), 'utf8');
const VIEWPORT_TELEMETRY = readFileSync(
    new URL('./scroll/transcriptViewportTelemetry.ts', import.meta.url),
    'utf8',
);
const VIEWPORT_CONTROLLER = readFileSync(
    new URL('./viewport/createTranscriptViewportController.ts', import.meta.url),
    'utf8',
);
const WEB_DOM_DRIVER = readFileSync(
    new URL('./viewport/driver/webDom.ts', import.meta.url),
    'utf8',
);
const NATIVE_INVERTED_DRIVER = readFileSync(
    new URL('./viewport/driver/nativeInvertedFlashList.ts', import.meta.url),
    'utf8',
);
const COMMAND_HOST_URL = new URL('./viewport/driver/commandHost.ts', import.meta.url);
const COMMAND_HOST = existsSync(COMMAND_HOST_URL)
    ? readFileSync(COMMAND_HOST_URL, 'utf8')
    : '';
const ENTRY_RESTORE_OWNER_URL = new URL('./viewport/entryRestore/entryRestoreOwner.ts', import.meta.url);
const ENTRY_RESTORE_OWNER = existsSync(ENTRY_RESTORE_OWNER_URL)
    ? readFileSync(ENTRY_RESTORE_OWNER_URL, 'utf8')
    : '';
const NATIVE_INVERTED_FACT_SOURCE = readFileSync(
    new URL('./viewport/driver/nativeInvertedFlashListFacts.ts', import.meta.url),
    'utf8',
);
const SIDECHAIN_OLDER_LOAD_OBSERVATION = readFileSync(
    new URL('./viewport/shell/sidechainOlderLoadObservation.ts', import.meta.url),
    'utf8',
);
const NATIVE_VIEWPORT_ANCHOR = readFileSync(
    new URL('./transcriptNativeViewportAnchor.ts', import.meta.url),
    'utf8',
);
const NATIVE_INVERTED_RAW_SCROLL_URL = new URL('./viewport/driver/nativeInvertedRawScroll.ts', import.meta.url);
const VIEWPORT_DRIVER_TYPES = readFileSync(
    new URL('./viewport/driver/types.ts', import.meta.url),
    'utf8',
);
const NATIVE_SCROLL_FOLLOW_INTENT = readFileSync(
    new URL('./viewport/lifecycle/nativeScrollFollowIntent.ts', import.meta.url),
    'utf8',
);
const NATIVE_SCROLL_FACTS_OBSERVATION = readFileSync(
    new URL('./viewport/lifecycle/nativeScrollFactsObservation.ts', import.meta.url),
    'utf8',
);
const NATIVE_SCROLL_AWAY_GESTURE_LIVE_TAIL_BAIL = readFileSync(
    new URL('./viewport/lifecycle/nativeScrollAwayGestureLiveTailBail.ts', import.meta.url),
    'utf8',
);
const NATIVE_SCROLL_RELEASE_LIVE_TAIL_GENERIC_EFFECT = readFileSync(
    new URL('./viewport/lifecycle/nativeScrollReleaseLiveTailGenericEffect.ts', import.meta.url),
    'utf8',
);
const NATIVE_OBSERVED_VIEWPORT_STATE_GENERIC_EFFECT = readFileSync(
    new URL('./viewport/lifecycle/nativeObservedViewportStateGenericEffect.ts', import.meta.url),
    'utf8',
);
const NATIVE_SCROLL_READ_ONLY_VISIBLE_BOTTOM = readFileSync(
    new URL('./viewport/lifecycle/nativeScrollReadOnlyVisibleBottom.ts', import.meta.url),
    'utf8',
);
const LIFECYCLE_HOST = readFileSync(
    new URL('./viewport/lifecycle/lifecycleHost.ts', import.meta.url),
    'utf8',
);
const NATIVE_SCROLL_PASSIVE_DRIFT_BAIL = readFileSync(
    new URL('./viewport/lifecycle/nativeScrollPassiveDriftBail.ts', import.meta.url),
    'utf8',
);
const NATIVE_OFFSET_ESCAPE_RELEASE = readFileSync(
    new URL('./viewport/lifecycle/nativeOffsetEscapeRelease.ts', import.meta.url),
    'utf8',
);
const LOCAL_TRANSCRIPT_INTERACTION_AUTO_PIN_DEFERRAL = readFileSync(
    new URL('./viewport/lifecycle/localTranscriptInteractionAutoPinDeferral.ts', import.meta.url),
    'utf8',
);
const NATIVE_BOTTOM_FOLLOW_REARM_ADOPTION = readFileSync(
    new URL('./viewport/lifecycle/nativeBottomFollowRearmAdoption.ts', import.meta.url),
    'utf8',
);
const NATIVE_BOTTOM_FOLLOW_REARM_RESET_URL = new URL(
    './viewport/lifecycle/nativeBottomFollowRearmReset.ts',
    import.meta.url,
);
const NATIVE_BOTTOM_FOLLOW_REARM_RESET = existsSync(NATIVE_BOTTOM_FOLLOW_REARM_RESET_URL)
    ? readFileSync(NATIVE_BOTTOM_FOLLOW_REARM_RESET_URL, 'utf8')
    : '';
const NATIVE_MOMENTUM_SETTLE_AWAY_RELEASE_URL = new URL(
    './viewport/lifecycle/nativeMomentumSettleAwayRelease.ts',
    import.meta.url,
);
const NATIVE_MOMENTUM_SETTLE_AWAY_RELEASE = existsSync(NATIVE_MOMENTUM_SETTLE_AWAY_RELEASE_URL)
    ? readFileSync(NATIVE_MOMENTUM_SETTLE_AWAY_RELEASE_URL, 'utf8')
    : '';
const NATIVE_TRUSTED_BOTTOM_ARRIVAL_URL = new URL(
    './viewport/lifecycle/nativeTrustedBottomArrival.ts',
    import.meta.url,
);
const NATIVE_TRUSTED_BOTTOM_ARRIVAL = existsSync(NATIVE_TRUSTED_BOTTOM_ARRIVAL_URL)
    ? readFileSync(NATIVE_TRUSTED_BOTTOM_ARRIVAL_URL, 'utf8')
    : '';
const NATIVE_SETTLED_RETURN_ANCHOR_CAPTURE_URL = new URL(
    './viewport/lifecycle/nativeSettledReturnAnchorCapture.ts',
    import.meta.url,
);
const NATIVE_SETTLED_RETURN_ANCHOR_CAPTURE = existsSync(NATIVE_SETTLED_RETURN_ANCHOR_CAPTURE_URL)
    ? readFileSync(NATIVE_SETTLED_RETURN_ANCHOR_CAPTURE_URL, 'utf8')
    : '';
const NATIVE_RETURN_TO_LIVE_TAIL_URL = new URL(
    './viewport/lifecycle/nativeReturnToLiveTail.ts',
    import.meta.url,
);
const NATIVE_RETURN_TO_LIVE_TAIL = existsSync(NATIVE_RETURN_TO_LIVE_TAIL_URL)
    ? readFileSync(NATIVE_RETURN_TO_LIVE_TAIL_URL, 'utf8')
    : '';
const NATIVE_EXPLICIT_JUMP_CONFIRMATION_URL = new URL(
    './viewport/lifecycle/nativeExplicitJumpConfirmation.ts',
    import.meta.url,
);
const NATIVE_EXPLICIT_JUMP_CONFIRMATION = existsSync(NATIVE_EXPLICIT_JUMP_CONFIRMATION_URL)
    ? readFileSync(NATIVE_EXPLICIT_JUMP_CONFIRMATION_URL, 'utf8')
    : '';
const NATIVE_ENTRY_SETTLE_CONFIRMATION_URL = new URL(
    './viewport/lifecycle/nativeEntrySettleConfirmation.ts',
    import.meta.url,
);
const NATIVE_ENTRY_SETTLE_CONFIRMATION = existsSync(NATIVE_ENTRY_SETTLE_CONFIRMATION_URL)
    ? readFileSync(NATIVE_ENTRY_SETTLE_CONFIRMATION_URL, 'utf8')
    : '';
const NATIVE_CONFIRMATION_OWNER_URL = new URL(
    './viewport/lifecycle/nativeConfirmationOwner.ts',
    import.meta.url,
);
const NATIVE_CONFIRMATION_OWNER = existsSync(NATIVE_CONFIRMATION_OWNER_URL)
    ? readFileSync(NATIVE_CONFIRMATION_OWNER_URL, 'utf8')
    : '';
const SESSION_ENTRY_RENDER_RESET_EFFECTS_URL = new URL(
    './viewport/lifecycle/sessionEntryRenderResetEffects.ts',
    import.meta.url,
);
const SESSION_ENTRY_RENDER_RESET_EFFECTS = existsSync(SESSION_ENTRY_RENDER_RESET_EFFECTS_URL)
    ? readFileSync(SESSION_ENTRY_RENDER_RESET_EFFECTS_URL, 'utf8')
    : '';
const SESSION_ENTRY_VIEWPORT_URL = new URL(
    './viewport/lifecycle/sessionEntryViewport.ts',
    import.meta.url,
);
const SESSION_ENTRY_VIEWPORT = existsSync(SESSION_ENTRY_VIEWPORT_URL)
    ? readFileSync(SESSION_ENTRY_VIEWPORT_URL, 'utf8')
    : '';
const ENTRY_RESTORE_CLOSE_EFFECTS_URL = new URL(
    './viewport/entryRestore/entryRestoreCloseEffects.ts',
    import.meta.url,
);
const ENTRY_RESTORE_CLOSE_EFFECTS = existsSync(ENTRY_RESTORE_CLOSE_EFFECTS_URL)
    ? readFileSync(ENTRY_RESTORE_CLOSE_EFFECTS_URL, 'utf8')
    : '';
const NATIVE_PREPEND_CLOSE_EFFECTS_URL = new URL(
    './viewport/prepend/prependCloseEffects.ts',
    import.meta.url,
);
const NATIVE_PREPEND_CLOSE_EFFECTS = existsSync(NATIVE_PREPEND_CLOSE_EFFECTS_URL)
    ? readFileSync(NATIVE_PREPEND_CLOSE_EFFECTS_URL, 'utf8')
    : '';
const NATIVE_PREPEND_OWNER_URL = new URL(
    './viewport/prepend/nativePrependOwner.ts',
    import.meta.url,
);
const NATIVE_PREPEND_OWNER = existsSync(NATIVE_PREPEND_OWNER_URL)
    ? readFileSync(NATIVE_PREPEND_OWNER_URL, 'utf8')
    : '';
const CONTENT_GROWTH_LIVE_TAIL_COMMAND = readFileSync(
    new URL('./viewport/lifecycle/contentGrowthLiveTailCommand.ts', import.meta.url),
    'utf8',
);
const NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY = readFileSync(
    new URL('./viewport/nativeBottomFollowObservationPolicy.ts', import.meta.url),
    'utf8',
);
const GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE = readFileSync(
    new URL('./viewport/lifecycle/genericScrollObservationViewportState.ts', import.meta.url),
    'utf8',
);
const WEB_SCROLL_FACTS_OBSERVATION = readFileSync(
    new URL('./viewport/lifecycle/webScrollFactsObservation.ts', import.meta.url),
    'utf8',
);
const WEB_SCROLL_OBSERVATION_GENERIC_EFFECT = readFileSync(
    new URL('./viewport/lifecycle/webScrollObservationGenericEffect.ts', import.meta.url),
    'utf8',
);
const WEB_SCROLL_FALLBACK_FOLLOW_INTENT = readFileSync(
    new URL('./viewport/lifecycle/webScrollFallbackFollowIntent.ts', import.meta.url),
    'utf8',
);
const SCROLL_OBSERVATION_HOST_URL = new URL(
    './viewport/lifecycle/scrollObservationHost.ts',
    import.meta.url,
);
const SCROLL_OBSERVATION_HOST = existsSync(SCROLL_OBSERVATION_HOST_URL)
    ? readFileSync(SCROLL_OBSERVATION_HOST_URL, 'utf8')
    : '';
const SCROLL_OBSERVATION_HOST_PLAN_APPLIER_URL = new URL(
    './viewport/lifecycle/scrollObservationHostPlanApplier.ts',
    import.meta.url,
);
const SCROLL_OBSERVATION_HOST_PLAN_APPLIER = existsSync(SCROLL_OBSERVATION_HOST_PLAN_APPLIER_URL)
    ? readFileSync(SCROLL_OBSERVATION_HOST_PLAN_APPLIER_URL, 'utf8')
    : '';
const TRANSCRIPT_MEASUREMENT_HOST_URL = new URL(
    './measurement/transcriptMeasurementHost.ts',
    import.meta.url,
);
const TRANSCRIPT_MEASUREMENT_HOST = existsSync(TRANSCRIPT_MEASUREMENT_HOST_URL)
    ? readFileSync(TRANSCRIPT_MEASUREMENT_HOST_URL, 'utf8')
    : '';
const LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER_URL = new URL(
    './viewport/lifecycle/layoutContentSizeObservationApplier.ts',
    import.meta.url,
);
const LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER = existsSync(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER_URL)
    ? readFileSync(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER_URL, 'utf8')
    : '';

describe('G1 viewport seam boundary — ChatList host holds no raw scroll primitives', () => {
    it('routes command write admission through the viewport command controller, not ChatList', () => {
        expect(CHATLIST).toContain('createTranscriptViewportCommandController');
        expect(CHATLIST).toContain('viewportCommandControllerRef');
        expect(CHATLIST).toContain('viewportCommandController.setCurrentSessionId(props.sessionId)');
        expect(CHATLIST).not.toContain('resolveWriteAdmission(');
    });

    it('routes command execution composition through the viewport command host, not ChatList', () => {
        expect(COMMAND_HOST).toContain('createTranscriptViewportCommandHost');
        expect(CHATLIST).toContain('createTranscriptViewportCommandHost');
        expect(CHATLIST).toContain('commandHost.execute(');
        expect(CHATLIST).toContain('commandHost.executeWithAnimation(');
        expect(CHATLIST).toContain('commandHost.restoreWebPrependAnchor(');
        expect(CHATLIST).not.toContain("from '@/components/sessions/transcript/viewport/performTranscriptViewportCommand'");
        expect(CHATLIST).not.toContain("from '@/components/sessions/transcript/viewport/driver/webDom'");
        expect(CHATLIST).not.toContain('executeViewportCommandWithPerform');
        expect(CHATLIST).not.toContain('function withTranscriptViewportCommandAnimation');
    });

    it('routes measurement and layout-cache host policy through the measurement host', () => {
        expect(existsSync(TRANSCRIPT_MEASUREMENT_HOST_URL)).toBe(true);
        expect(CHATLIST).toContain('createTranscriptMeasurementHost');
        expect(CHATLIST).toContain('measurementHost.observeRowLayoutMutation');
        expect(CHATLIST).toContain('measurementHost.observeContentSizeChange');
        expect(TRANSCRIPT_MEASUREMENT_HOST).toContain('requestGlobalLayoutInvalidation');
        expect(TRANSCRIPT_MEASUREMENT_HOST).toContain('clear-layout-cache');
        expect(TRANSCRIPT_MEASUREMENT_HOST).toContain('hasNativeContentMeasurementForSession');

        expect(CHATLIST).not.toContain('createTranscriptMeasurementReconciler({');
        expect(CHATLIST).not.toContain('measurementReconciler.requestGlobalLayoutInvalidation(');
        expect(CHATLIST).not.toContain('listRef.current?.clearLayoutCacheOnUpdate');
        expect(CHATLIST).not.toContain('layoutInvalidationCommitTokenRef');
        expect(CHATLIST).not.toContain('nativeContentMeasurementSessionRef');
        expect(CHATLIST).not.toContain('lastMeasuredContentActivityKeyRef');
        expect(CHATLIST).not.toContain('const resolveMeasuredContentHeight');
    });

    it('routes main shell layout and content-size observation ordering through the lifecycle applier', () => {
        expect(existsSync(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER_URL)).toBe(true);
        expect(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER).toContain('applyTranscriptLayoutObservation');
        expect(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER).toContain('applyTranscriptContentSizeObservation');
        expect(CHATLIST).toContain('applyTranscriptLayoutObservation');
        expect(CHATLIST).toContain('applyTranscriptContentSizeObservation');
        expect(CHATLIST).toContain('layoutObservationApplierEffects');
        expect(CHATLIST).toContain('contentSizeObservationApplierEffects');

        const onLayoutStart = CHATLIST.indexOf('onLayout={(e: LayoutChangeEvent) => {');
        const onLayoutEnd = CHATLIST.indexOf('onContentSizeChange=', onLayoutStart);
        expect(onLayoutStart).toBeGreaterThanOrEqual(0);
        expect(onLayoutEnd).toBeGreaterThan(onLayoutStart);
        const onLayoutSource = CHATLIST.slice(onLayoutStart, onLayoutEnd);
        expect(onLayoutSource).toContain('applyTranscriptLayoutObservation({');
        expect(onLayoutSource).not.toContain('requestAutomaticLiveTailPin(');
        expect(onLayoutSource).not.toContain('observeNativePrependOwner()');
        expect(onLayoutSource).not.toContain('attemptEntryRestore()');

        const onContentSizeStart = CHATLIST.indexOf('onContentSizeChange={(_: number, h: number) => {');
        const onContentSizeEnd = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)', onContentSizeStart);
        expect(onContentSizeStart).toBeGreaterThanOrEqual(0);
        expect(onContentSizeEnd).toBeGreaterThan(onContentSizeStart);
        const onContentSizeSource = CHATLIST.slice(onContentSizeStart, onContentSizeEnd);
        expect(onContentSizeSource).toContain('applyTranscriptContentSizeObservation({');
        expect(onContentSizeSource).not.toContain('requestAutomaticLiveTailPin(');
        expect(onContentSizeSource).not.toContain('releaseNativeBottomFollowIfFlashListOffsetEscaped(');
        expect(onContentSizeSource).not.toContain('observeNativePrependOwner()');
        expect(onContentSizeSource).not.toContain('attemptEntryRestore()');
    });

    it('keeps volatile hot-cold driver facts lazy so commands read the current split state', () => {
        const start = CHATLIST.indexOf('const viewportDriverDeps');
        const end = CHATLIST.indexOf('const commandHost', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const driverDepsSource = CHATLIST.slice(start, end);

        expect(driverDepsSource).toContain('get shouldUseNativeHotColdSplit()');
        expect(driverDepsSource).toContain('shouldUseNativeHotColdSplitRef.current');
        expect(driverDepsSource).toContain('get shouldUseWebHotColdSplit()');
        expect(driverDepsSource).toContain('shouldUseWebHotColdSplitRef.current');
        expect(driverDepsSource).toContain('get coldItemCount()');
        expect(driverDepsSource).toContain('coldItemCountRef.current');
    });

    it('issues no raw scroll WRITE — scrollToIndex / scrollToOffset / scrollToEnd / scrollTop= are owned by performTranscriptViewportCommand', () => {
        expect(CHATLIST).not.toMatch(/\.scrollToIndex\s*\(/);
        expect(CHATLIST).not.toMatch(/\.scrollToOffset\s*\(/);
        expect(CHATLIST).not.toMatch(/\.scrollToEnd\s*\(/);
        // scrollTop ASSIGNMENT (not a === comparison and not a *ScrollTop variable name).
        expect(CHATLIST).not.toMatch(/\.scrollTop\s*=[^=]/);
    });

    it('reads the raw native scroll offset only through readNativeAbsoluteScrollOffset — no inline getAbsoluteLastScrollOffset CALL', () => {
        // The structural `ScrollableChatListRef` type member declaration is allowed; only CALL forms are banned.
        expect(CHATLIST).not.toMatch(/getAbsoluteLastScrollOffset\s*\?\.\s*\(/);
        expect(CHATLIST).not.toMatch(/\.getAbsoluteLastScrollOffset\s*\(/);
    });

    it('performs no inline raw orientation MAPPING — toCanonicalScrollOffset / fromCanonicalScrollOffset are owned by the fact source toCanonicalOffset', () => {
        expect(CHATLIST).not.toMatch(/\btoCanonicalScrollOffset\s*\(/);
        expect(CHATLIST).not.toMatch(/\bfromCanonicalScrollOffset\s*\(/);
    });

    it('keeps raw scroll writes in platform drivers, not in the command dispatcher', () => {
        expect(COMMAND_WRITER).not.toMatch(/\.scrollToIndex\s*\(/);
        expect(COMMAND_WRITER).not.toMatch(/\.scrollToOffset\s*\(/);
        expect(COMMAND_WRITER).not.toMatch(/\.scrollToEnd\s*\(/);
        expect(COMMAND_WRITER).not.toMatch(/\.scrollTop\s*=[^=]/);
    });

    it('keeps renderer implementation switches out of the viewport driver seam', () => {
        expect(VIEWPORT_DRIVER_TYPES).not.toContain('listImplementation:');
        expect(COMMAND_WRITER).not.toContain('listImplementation');
    });

    it('keeps renderer implementation switches out of the first-paint controller input', () => {
        const firstPaintStart = VIEWPORT_TYPES.indexOf("type: 'first-paint'");
        const nextInputStart = VIEWPORT_TYPES.indexOf('| Readonly<{', firstPaintStart + 1);
        expect(firstPaintStart).toBeGreaterThanOrEqual(0);
        expect(nextInputStart).toBeGreaterThan(firstPaintStart);
        const firstPaintInputSource = VIEWPORT_TYPES.slice(firstPaintStart, nextInputStart);

        expect(VIEWPORT_TYPES).not.toContain('TranscriptViewportListImplementation');
        expect(firstPaintInputSource).not.toContain('listImplementation');
        expect(firstPaintInputSource).not.toContain('platform:');
    });

    it('deletes active runtime listImplementation host gates while telemetry owns historical labels', () => {
        const activeRuntimeGate = /\blistImplementation\s*(?:===|!==)\s*'flash_v2'/;

        expect(CHATLIST).not.toContain('const listImplementation =');
        expect(CHATLIST).not.toMatch(activeRuntimeGate);
        expect(LIST_ORIENTATION).not.toContain('implementation:');
        expect(VIEWPORT_TELEMETRY).toContain("'flatlist_legacy'");
        expect(VIEWPORT_TELEMETRY).toContain("'web-fallback'");
    });

    it('keeps native inverted raw-scroll math in the driver owner, not listOrientation', () => {
        expect(existsSync(NATIVE_INVERTED_RAW_SCROLL_URL)).toBe(true);

        for (const rawScrollHelper of [
            'toCanonicalScrollOffset',
            'fromCanonicalScrollOffset',
            'resolveBottomRawScrollOffset',
            'resolveBottomRawScrollCommandOffset',
        ]) {
            expect(LIST_ORIENTATION).not.toMatch(new RegExp(`export function ${rawScrollHelper}\\b`));
            expect(LIST_ORIENTATION).not.toMatch(new RegExp(`function ${rawScrollHelper}\\b`));
        }

        expect(NATIVE_INVERTED_DRIVER).toContain('./nativeInvertedRawScroll');
        expect(NATIVE_INVERTED_FACT_SOURCE).toContain('./nativeInvertedRawScroll');
        expect(NATIVE_INVERTED_DRIVER).not.toContain('@/components/sessions/transcript/listOrientation');
        expect(NATIVE_INVERTED_FACT_SOURCE).not.toContain('@/components/sessions/transcript/listOrientation');
    });

    it('deletes the duplicate mutable listOrientationRef from the host', () => {
        expect(CHATLIST).not.toContain('listOrientationRef');
    });

    it('resolves reached-edge polarity through web semantics or the native fact source, not listOrientationRef.current', () => {
        const edgeMapperStart = CHATLIST.indexOf('const resolveViewportReachedEdge');
        const edgeMapperEnd = CHATLIST.indexOf('const observePaginationEdgeReachedNudge', edgeMapperStart);
        expect(edgeMapperStart).toBeGreaterThanOrEqual(0);
        expect(edgeMapperEnd).toBeGreaterThan(edgeMapperStart);
        const edgeMapperSource = CHATLIST.slice(edgeMapperStart, edgeMapperEnd);

        expect(edgeMapperSource).toContain("Platform.OS === 'web'");
        expect(edgeMapperSource).toContain('resolveReachedEdge');
        expect(edgeMapperSource).not.toContain('listOrientationRef.current');
    });

    it('routes native observed offsets through the fact source instead of host-owned canonicalization', () => {
        expect(NATIVE_INVERTED_FACT_SOURCE).toContain('resolveObservedOffset');
        expect(CHATLIST).toContain('resolveNativeObservedScrollOffset');
        expect(CHATLIST).not.toContain('const resolveCanonicalScrollOffset');
        expect(CHATLIST).not.toContain('resolveCanonicalScrollOffset(');

        const edgeNudgeStart = CHATLIST.indexOf('const observePaginationEdgeReachedNudge');
        const edgeNudgeEnd = CHATLIST.indexOf('React.useLayoutEffect(() =>', edgeNudgeStart);
        expect(edgeNudgeStart).toBeGreaterThanOrEqual(0);
        expect(edgeNudgeEnd).toBeGreaterThan(edgeNudgeStart);
        const edgeNudgeSource = CHATLIST.slice(edgeNudgeStart, edgeNudgeEnd);
        expect(edgeNudgeSource).toContain('resolveNativeObservedScrollOffset');
        expect(edgeNudgeSource).not.toContain('contentH - layoutH - canonical');

        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);
        expect(onScrollSource).toContain('resolveNativeObservedScrollOffset');
        expect(onScrollSource).toContain('isAtRawLiveTail');
        expect(onScrollSource).not.toContain('contentH - layoutH - canonical');
    });

    it('exposes restore-distance as semantic live-tail distance, not public restore-offset raw offset', () => {
        expect(VIEWPORT_TYPES).toContain("kind: 'restore-distance'");
        expect(VIEWPORT_TYPES).toContain('distanceFromLiveTailPx');
        expect(VIEWPORT_TYPES).not.toContain("kind: 'restore-offset'");
        expect(VIEWPORT_CONTROLLER).not.toContain("kind: 'restore-offset'");
    });

    it('exposes restore-anchor as anchor identity plus item offset, not public indexes or platform offsets', () => {
        const commandStart = VIEWPORT_TYPES.indexOf("kind: 'restore-anchor'");
        const commandEnd = VIEWPORT_TYPES.indexOf("kind: 'restore-visible-anchor'", commandStart);
        expect(commandStart).toBeGreaterThanOrEqual(0);
        expect(commandEnd).toBeGreaterThan(commandStart);
        const commandSource = VIEWPORT_TYPES.slice(commandStart, commandEnd);

        const inputStart = VIEWPORT_TYPES.indexOf("type: 'restore-anchor'");
        const inputEnd = VIEWPORT_TYPES.indexOf("type: 'jump-to-seq'", inputStart);
        expect(inputStart).toBeGreaterThanOrEqual(0);
        expect(inputEnd).toBeGreaterThan(inputStart);
        const inputSource = VIEWPORT_TYPES.slice(inputStart, inputEnd);

        const firstPaintStart = VIEWPORT_TYPES.indexOf("type: 'first-paint'");
        const firstPaintEnd = VIEWPORT_TYPES.indexOf('| Readonly<{', firstPaintStart + 1);
        expect(firstPaintStart).toBeGreaterThanOrEqual(0);
        expect(firstPaintEnd).toBeGreaterThan(firstPaintStart);
        const firstPaintSource = VIEWPORT_TYPES.slice(firstPaintStart, firstPaintEnd);

        expect(commandSource).toContain('target: TranscriptViewportRestoreAnchorTarget');
        expect(inputSource).toContain('anchor: TranscriptViewportAnchorIdentity');
        expect(inputSource).toContain('itemOffsetPx: number');
        expect(firstPaintSource).toContain('entrySnapshot?: TranscriptViewportEntrySnapshot | null');
        expect(VIEWPORT_TYPES).toContain('anchor?: TranscriptViewportAnchorIdentity | null');
        expect(VIEWPORT_TYPES).toContain('anchorItemOffsetPx?: number');

        expect(VIEWPORT_TYPES).not.toContain("kind: 'restore-index'");
        expect(commandSource).not.toContain('index:');
        expect(commandSource).not.toContain('viewOffset');
        expect(inputSource).not.toContain('index:');
        expect(inputSource).not.toContain('viewOffset');
        expect(VIEWPORT_TYPES).not.toContain('anchorIndex');
        expect(VIEWPORT_TYPES).not.toContain('anchorViewOffset');
        expect(VIEWPORT_CONTROLLER).not.toContain("kind: 'restore-index'");
        expect(WEB_DOM_DRIVER).toContain('resolveRestoreAnchorIndex');
        expect(NATIVE_INVERTED_DRIVER).toContain('resolveRestoreAnchorIndex');
    });

    it('does not expose the deleted generic scroll-offset command above the driver seam', () => {
        expect(VIEWPORT_TYPES).not.toContain("kind: 'scroll-offset'");
        expect(VIEWPORT_TYPES).not.toContain("type: 'scroll-offset'");
        expect(VIEWPORT_CONTROLLER).not.toContain("case 'scroll-offset'");
        expect(WEB_DOM_DRIVER).not.toContain("command.kind === 'scroll-offset'");
        expect(NATIVE_INVERTED_DRIVER).not.toContain("command.kind === 'scroll-offset'");
    });

    it('exposes public jump-to-seq commands as seq-only and leaves index resolution to drivers', () => {
        const commandStart = VIEWPORT_TYPES.indexOf("kind: 'jump-to-seq'");
        const commandEnd = VIEWPORT_TYPES.indexOf("kind: 'recover-jump-to-seq'", commandStart);
        expect(commandStart).toBeGreaterThanOrEqual(0);
        expect(commandEnd).toBeGreaterThan(commandStart);
        const commandSource = VIEWPORT_TYPES.slice(commandStart, commandEnd);

        const inputStart = VIEWPORT_TYPES.indexOf("type: 'jump-to-seq'");
        const inputEnd = VIEWPORT_TYPES.indexOf("type: 'recover-jump-to-seq'", inputStart);
        expect(inputStart).toBeGreaterThanOrEqual(0);
        expect(inputEnd).toBeGreaterThan(inputStart);
        const inputSource = VIEWPORT_TYPES.slice(inputStart, inputEnd);

        expect(commandSource).toContain('seq: number');
        expect(inputSource).toContain('seq: number');
        expect(commandSource).not.toContain('index');
        expect(inputSource).not.toContain('index');
        expect(WEB_DOM_DRIVER).toContain('resolveJumpToSeqIndex');
        expect(NATIVE_INVERTED_DRIVER).toContain('resolveJumpToSeqIndex');
    });

    it('routes web bottom-follow adjustment through semantic live-tail distance preservation', () => {
        const start = CHATLIST.indexOf('const applyWebBottomFollowAdjustment');
        const end = CHATLIST.indexOf('const pinNativeFlashListToBottomIfMeasured', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const applyWebBottomFollowAdjustmentSource = CHATLIST.slice(start, end);

        expect(applyWebBottomFollowAdjustmentSource).toContain("type: 'preserve-live-tail-distance'");
        expect(applyWebBottomFollowAdjustmentSource).toContain('previousDistanceFromLiveTailPx');
        expect(applyWebBottomFollowAdjustmentSource).not.toContain('targetOffsetY: ' + 'targetScrollTop');
        expect(applyWebBottomFollowAdjustmentSource).not.toContain('resolveWeb' + 'BottomFollowAdjustment');
        expect(CHATLIST).not.toContain('scroll/resolveWeb' + 'BottomFollowAdjustment');
    });

    it('routes visible web viewport anchor correction through semantic restore-visible-anchor instead of generic scroll-offset', () => {
        const start = CHATLIST.indexOf('const restoreWebViewportAnchorThroughViewportCommand');
        const end = CHATLIST.indexOf('const [firstListPaintObserved', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const restoreWebViewportAnchorThroughViewportCommandSource = CHATLIST.slice(start, end);

        expect(VIEWPORT_TYPES).toContain("kind: 'restore-visible-anchor'");
        expect(VIEWPORT_CONTROLLER).toContain("kind: 'restore-visible-anchor'");
        expect(restoreWebViewportAnchorThroughViewportCommandSource).toContain('commandHost.restoreWebVisibleAnchor({');
        expect(restoreWebViewportAnchorThroughViewportCommandSource).toContain('anchor: params.anchor');
        expect(restoreWebViewportAnchorThroughViewportCommandSource).not.toContain("type: 'scroll-offset'");
        expect(restoreWebViewportAnchorThroughViewportCommandSource).not.toContain('targetScrollTop');
        expect(restoreWebViewportAnchorThroughViewportCommandSource).not.toContain('restoreWebTranscriptViewportAnchor');
    });

    it('routes web prepend restore through semantic restore-web-prepend-anchor instead of generic scroll-offset', () => {
        const start = CHATLIST.indexOf('const restoreWebPrependAnchorThroughViewportCommand');
        const end = CHATLIST.indexOf('const restoreWebViewportAnchorThroughViewportCommand', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const restoreWebPrependAnchorThroughViewportCommandSource = CHATLIST.slice(start, end);

        expect(VIEWPORT_TYPES).toContain("kind: 'restore-web-prepend-anchor'");
        expect(VIEWPORT_CONTROLLER).toContain("kind: 'restore-web-prepend-anchor'");
        expect(COMMAND_HOST).toContain("type: 'restore-web-prepend-anchor'");
        expect(COMMAND_HOST).toContain('performWebDomPrependAnchorRestoreCommand');
        expect(restoreWebPrependAnchorThroughViewportCommandSource).toContain('commandHost.restoreWebPrependAnchor({');
        expect(restoreWebPrependAnchorThroughViewportCommandSource).not.toContain("type: 'scroll-offset'");
        expect(restoreWebPrependAnchorThroughViewportCommandSource).not.toContain('performWebDomPrependAnchorRestoreCommand');
        expect(restoreWebPrependAnchorThroughViewportCommandSource).not.toContain('writeWebRestoreScrollTopThroughViewportCommand');
        expect(restoreWebPrependAnchorThroughViewportCommandSource).not.toContain('restoreWebTranscriptPrependAnchor');
    });

    it('routes the native prepend fallback through the prepend host and native owner', () => {
        const prependHostUrl = new URL('./viewport/prepend/host/useTranscriptPrependHost.ts', import.meta.url);
        const prependHostSource = readFileSync(prependHostUrl, 'utf8');

        expect(existsSync(NATIVE_PREPEND_OWNER_URL)).toBe(true);
        expect(NATIVE_PREPEND_OWNER).toContain('createNativePrependOwner');
        expect(NATIVE_PREPEND_OWNER).toContain("type: 'apply-history-correction'");
        expect(NATIVE_PREPEND_OWNER).toContain('targetDistanceFromHistoryStartPx');
        expect(CHATLIST).toContain('useTranscriptPrependHost');
        expect(prependHostSource).toContain('createNativePrependOwner');
        expect(prependHostSource).toContain('nativeOwner.begin(');
        expect(prependHostSource).toContain('nativeOwner.armCommit(');
        expect(prependHostSource).toContain('nativeOwner.observe(');
        expect(prependHostSource).toContain('nativeOwner.runLayoutTimeout(');
        expect(prependHostSource).toContain('nativeOwner.runQuietReobserve(');
        expect(prependHostSource).toContain('nativeOwner.runCorrectorReobserve(');
        expect(prependHostSource).toContain('nativeOwner.recordCorrectorCorrection({');
        expect(prependHostSource).toContain('nativeOwner.trustedScroll(');
        expect(prependHostSource).toContain('executeViewportCommand(resolveViewportCommand(effect.command))');
        expect(prependHostSource).not.toContain("type: 'scroll-offset'");
        expect(prependHostSource).not.toContain('offsetY: write.write.targetOffsetY');
    });

    it('keeps native prepend close effects owned by viewport owners after deleting the vendor correction bridge', () => {
        const prependHostUrl = new URL('./viewport/prepend/host/useTranscriptPrependHost.ts', import.meta.url);
        const prependHostSource = readFileSync(prependHostUrl, 'utf8');

        expect(prependHostSource).toContain('const nativeCorrectorReobserveTimerRef = React.useRef');
        expect(prependHostSource).not.toContain('transaction.onCorrectorCorrectionApplied');
        expect(prependHostSource).not.toContain("transaction.state() === 'committed'");
        expect(prependHostSource).not.toContain('nativePrependCorrectorNudgeRef.current = setTimeout');
        expect(CHATLIST).not.toContain('nativePrependCorrectorNudgeRef');
        expect(CHATLIST).toContain('useTranscriptPrependHost');

        expect(prependHostSource).toContain("case 'record-restore-decision-for-session':");
        expect(prependHostSource).toContain("case 'clear-corrector-reobserve':");
        expect(existsSync(NATIVE_PREPEND_CLOSE_EFFECTS_URL)).toBe(true);
        expect(NATIVE_PREPEND_CLOSE_EFFECTS).toContain('resolveNativePrependCloseEffects');
        expect(NATIVE_PREPEND_OWNER).toContain('resolveNativePrependCloseEffects');
        expect(CHATLIST).not.toContain("from '@/components/sessions/transcript/viewport/prepend/prependCloseEffects'");
        expect(CHATLIST).not.toContain('resolveNativePrependCloseEffects({');
    });

    it('routes native jump-to-seq index failures through semantic recovery instead of host offset math', () => {
        const start = CHATLIST.indexOf('onScrollToIndexFailed');
        const end = CHATLIST.indexOf('header={mainTranscriptListShellEdgeSlots.listHeaderNode}', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const onScrollToIndexFailedSource = CHATLIST.slice(start, end);

        expect(onScrollToIndexFailedSource).toContain("type: 'recover-jump-to-seq'");
        expect(onScrollToIndexFailedSource).toContain('failedRenderedIndex');
        expect(onScrollToIndexFailedSource).toContain('averageItemLengthPx');
        expect(onScrollToIndexFailedSource).not.toContain("type: 'scroll-offset'");
        expect(onScrollToIndexFailedSource).not.toMatch(/averageItemLength\s*\*\s*(?:info\.)?index/);
    });

    it('routes automatic native follow-bottom through lifecycle host ownership instead of public target offsets', () => {
        const typeStart = VIEWPORT_TYPES.indexOf("type: 'auto-follow'");
        const typeEnd = VIEWPORT_TYPES.indexOf("type: 'preserve-live-tail-distance'", typeStart);
        expect(typeStart).toBeGreaterThanOrEqual(0);
        expect(typeEnd).toBeGreaterThan(typeStart);
        const autoFollowTypeSource = VIEWPORT_TYPES.slice(typeStart, typeEnd);
        const skipCommandSource = VIEWPORT_TYPES.slice(
            VIEWPORT_TYPES.indexOf("kind: 'skip-native-js-pin'"),
            VIEWPORT_TYPES.indexOf('export type TranscriptViewportControllerInput'),
        );
        const start = CHATLIST.indexOf('const pinNativeFlashListToBottomIfMeasured');
        const end = CHATLIST.indexOf('const flushPendingNativeMountSettleBottomPin', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const nativeAutoFollowSource = CHATLIST.slice(start, end);

        expect(autoFollowTypeSource).not.toContain('targetOffsetY');
        expect(skipCommandSource).not.toContain('targetOffsetY');
        expect(nativeAutoFollowSource).toContain('lifecycleHost.planMeasuredNativeLiveTailPin({');
        expect(nativeAutoFollowSource).toContain('applyNativeMeasuredPinPlanResult(measuredPinPlan)');
        expect(nativeAutoFollowSource).not.toContain("type: 'auto-follow'");
        expect(LIFECYCLE_HOST).toContain('resolveNativeMeasuredBottomPinCommandResultPlan({');
        expect(LIFECYCLE_HOST).toContain('skipAutomaticNativeJsPin');
        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).toContain("type: 'auto-follow'");
        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).toContain('observedContentHeightPx');
        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).toContain('observedLayoutHeightPx');
        expect(LIFECYCLE_HOST).not.toContain('targetOffsetY');
        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).not.toContain('targetOffsetY: offset');
        expect(nativeAutoFollowSource).not.toContain('targetOffsetY: offset');
    });

    it('routes pending native mount-settle bottom-pin flush planning through the lifecycle host', () => {
        const start = CHATLIST.indexOf('const flushPendingNativeMountSettleBottomPin = React.useCallback');
        const end = CHATLIST.indexOf(
            'flushPendingNativeMountSettleBottomPinRef.current = flushPendingNativeMountSettleBottomPin;',
            start,
        );
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const flushSource = CHATLIST.slice(start, end);

        expect(CHATLIST).toContain('createTranscriptLifecycleHost');
        expect(flushSource).toContain('lifecycleHost.planNativeMountSettlePendingPinFlush({');
        expect(flushSource).toContain('applyNativeMountSettlePendingPinFlushPlan(');
        expect(flushSource).not.toMatch(
            /if\s*\(\s*!pendingNativeMountSettleBottomPinRef\.current\s*&&\s*!nativeMountSettleDeadlineReachedRef\.current\s*\)\s*return/,
        );
        expect(flushSource).not.toMatch(/if\s*\(\s*!shouldKeepPendingNativeMountSettleBottomPin\(\)\s*\)/);
        expect(flushSource).not.toMatch(
            /mountSettleCoordinatorRef\.current\?\.getSnapshot\(\)\.isMountSettleActive\s*===\s*true\s*&&\s*!\s*nativeMountSettleDeadlineReachedRef\.current/,
        );
        expect(flushSource).not.toContain('pinNativeFlashListToBottomIfMeasured({');
    });

    it('routes content-growth live-tail scheduling policy through the lifecycle host', () => {
        const start = CHATLIST.indexOf('const schedulePinToBottom = React.useCallback');
        const end = CHATLIST.indexOf('const applyScheduledContentGrowthLiveTailCommand = React.useCallback', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const scheduleSource = CHATLIST.slice(start, end);

        expect(CHATLIST).toContain('lifecycleHost.planContentGrowthLiveTailPinSchedule');
        expect(CHATLIST).toContain('lifecycleHost.planContentGrowthLiveTailScheduledPinFire');
        expect(LIFECYCLE_HOST).toContain('planContentGrowthLiveTailPinSchedule');
        expect(LIFECYCLE_HOST).toContain('planContentGrowthLiveTailScheduledPinFire');
        expect(scheduleSource).not.toContain('existing-scheduled-pin');
        expect(scheduleSource).not.toContain('native-stream-supersedes-stale-pin');
        expect(scheduleSource).not.toContain("waitMs === 0 && typeof raf === 'function'");
        expect(scheduleSource).not.toMatch(/scheduledPinRef\.current\s*=\s*\{/);
    });

    it('routes native bottom-follow completion planning through scrollObservationHost', () => {
        const start = CHATLIST.indexOf('const scrollObservationPlan = Platform.OS ===');
        const end = CHATLIST.indexOf('onMomentumScrollBegin', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const activeOnScrollObservationSource = CHATLIST.slice(start, end);

        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).toContain('resolveNativeBottomFollowCompletionEffects');
        expect(SCROLL_OBSERVATION_HOST).toContain('nativeBottomFollowCompletionEffects');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeBottomFollowCompletionEffects({');
        expect(activeOnScrollObservationSource).toContain('lastNativePinOffset: lastNativePinOffsetRef.current');
        expect(activeOnScrollObservationSource).toContain(
            'pendingBottomPin: pendingNativeMountSettleBottomPinRef.current',
        );
        expect(activeOnScrollObservationSource).toContain('visualBottomScrollOffset: observedNativeBottomPinOffset');
        expect(existsSync(SCROLL_OBSERVATION_HOST_PLAN_APPLIER_URL)).toBe(true);
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain(
            'callbacks.applyNativeBottomFollowCompletionEffects(plan.nativeBottomFollowCompletionEffects)',
        );
        expect(activeOnScrollObservationSource).not.toMatch(/scrollObservationPlan\.nativeBottomFollowCompletionEffects/);
        expect(activeOnScrollObservationSource).not.toMatch(/scrollObservationPlan\.nativePassiveScrollObservationEffect/);
        expect(activeOnScrollObservationSource).not.toMatch(/scrollObservationPlan\.nativeUserScrollTakeoverEffects/);
        expect(activeOnScrollObservationSource).not.toContain('passiveObservationEffect');
        expect(activeOnScrollObservationSource).not.toContain('nativeBottomFollowPinTargetObserved(');
        expect(activeOnScrollObservationSource).not.toContain('nativeBottomFollowCanCompletePendingPin(');
        expect(activeOnScrollObservationSource).not.toContain('nativeBottomFollowCanApplyCompletion(');
    });

    it('imports viewport facts from the driver folder, not the retired adapter folder', () => {
        expect(CHATLIST).not.toContain('viewport/adapter/');
    });

    it('keeps sidechain older-load ingress, offset normalization, dispatch, and telemetry behind the shell operation', () => {
        expect(CHAIN_TRANSCRIPT_LIST).toContain('viewport/shell/sidechainOlderLoadObservation');
        expect(CHAIN_TRANSCRIPT_LIST).not.toContain('viewport/driver/webDomOlderLoadObservation');
        expect(CHAIN_TRANSCRIPT_LIST).not.toContain('toCanonicalScrollOffset');
        expect(CHAIN_TRANSCRIPT_LIST).not.toMatch(/getAbsoluteLastScrollOffset\s*\?\.\s*\(/);
        expect(CHAIN_TRANSCRIPT_LIST).not.toMatch(/\.getAbsoluteLastScrollOffset\s*\(/);
        expect(CHAIN_TRANSCRIPT_LIST).not.toMatch(/olderPagination\.onScrollObservation\s*\(/);
        expect(CHAIN_TRANSCRIPT_LIST).not.toContain('TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX');
        expect(CHAIN_TRANSCRIPT_LIST).not.toContain('eventTarget.scrollTop');
        expect(CHAIN_TRANSCRIPT_LIST).not.toMatch(/target\?\.scrollTop/);
    });

    it('keeps sidechain native older-load raw reads and inverted mapping behind the observed-offset fact source', () => {
        expect(CHAIN_TRANSCRIPT_LIST).toContain('nativeObservedOffset');
        expect(CHAIN_TRANSCRIPT_LIST).toContain('resolveObservedOffset');
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toContain('readNativeAbsoluteScrollOffset');
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toMatch(/getAbsoluteLastScrollOffset\s*\?\.\s*\(/);
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toMatch(/\.getAbsoluteLastScrollOffset\s*\(/);
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toContain('toCanonicalScrollOffset');
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toMatch(/scrollableExtent\s*-\s*params\.offsetY/);
    });

    it('routes native viewport-anchor raw reads through the guarded driver helper', () => {
        const guardedReadCalls = NATIVE_VIEWPORT_ANCHOR.match(/\breadNativeAbsoluteScrollOffset\s*\(\s*ref\s*\)/g) ?? [];

        expect(NATIVE_VIEWPORT_ANCHOR).toContain('viewport/driver/readNativeAbsoluteScrollOffset');
        expect(guardedReadCalls).toHaveLength(2);
        expect(NATIVE_VIEWPORT_ANCHOR).not.toMatch(/\bgetAbsoluteLastScrollOffset\s*\(\s*\)/);
        expect(NATIVE_VIEWPORT_ANCHOR).not.toMatch(/getAbsoluteLastScrollOffset\s*\?\.\s*\(/);
        expect(NATIVE_VIEWPORT_ANCHOR).not.toMatch(/\.getAbsoluteLastScrollOffset\s*\(/);
    });

    it('keeps sidechain older-page loading and web prepend-growth restore behind shell operations', () => {
        const paginationLoadOlderSource = CHAIN_TRANSCRIPT_LIST.match(
            /const paginationLoadOlder = React\.useCallback\([\s\S]*?\n    \}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(CHAIN_TRANSCRIPT_LIST).toContain('viewport/shell/sidechainOlderPageLoad');
        expect(paginationLoadOlderSource).toContain('applySidechainPaginationOlderPageLoad');
        expect(paginationLoadOlderSource).not.toMatch(/hasMoreOlderRef\.current\s*===\s*false/);
        expect(paginationLoadOlderSource).not.toMatch(/buildWebPrependAnchor\s*\(/);
    });

    it('keeps sidechain jump-to-message materialization behind the shell operation', () => {
        expect(CHAIN_TRANSCRIPT_LIST).toContain('viewport/shell/sidechainJumpToMessage');
        expect(CHAIN_TRANSCRIPT_LIST).not.toMatch(/for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*25\s*;/);
        expect(CHAIN_TRANSCRIPT_LIST).not.toMatch(/itemsRef\.current\.findIndex\([\s\S]{0,160}jumpToMessageId/);
    });

    it('keeps sidechain initial bottom-pin request and raw fallback command behind the shell operation', () => {
        const pinToBottomSource = CHAIN_TRANSCRIPT_LIST.match(
            /const pinToBottom = React\.useCallback\([\s\S]*?\n    \}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(CHAIN_TRANSCRIPT_LIST).toContain('viewport/shell/sidechainInitialBottomPin');
        expect(pinToBottomSource).toContain('applySidechainInitialBottomPinRequest');
        expect(pinToBottomSource).not.toMatch(/\.scrollToIndex\s*\(/);
        expect(pinToBottomSource).not.toMatch(/\.scrollToOffset\s*\(/);
        expect(pinToBottomSource).not.toContain('fallbackOffset');
    });

    it('routes main and sidechain visual-update pacing through the shared transcript wait helper', () => {
        const inlineVisualUpdateWaitHelper = /const waitForNextVisualUpdate = React\.useCallback\(async \(\) => \{[\s\S]*?Promise\.resolve\(\)[\s\S]*?Promise\.resolve\(\)[\s\S]*?requestAnimationFrame[\s\S]*?\}, \[\]\);/;

        expect(CHATLIST).toContain('pagination/waitForNextTranscriptVisualUpdate');
        expect(CHAIN_TRANSCRIPT_LIST).toContain('pagination/waitForNextTranscriptVisualUpdate');
        expect(CHATLIST).not.toMatch(inlineVisualUpdateWaitHelper);
        expect(CHAIN_TRANSCRIPT_LIST).not.toMatch(inlineVisualUpdateWaitHelper);
    });

    it('routes native scroll follow-intent derivation through the lifecycle owner', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);

        expect(existsSync(SCROLL_OBSERVATION_HOST_URL)).toBe(true);
        expect(CHATLIST).toContain('createTranscriptScrollObservationHost');
        expect(onScrollSource).toContain('scrollObservationHost.observeScroll({');
        expect(onScrollSource).not.toContain('resolveNativeScrollFollowIntent({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollFollowIntent({');
        expect(NATIVE_SCROLL_FOLLOW_INTENT).toContain('resolveTranscriptBottomFollowIntent');
        expect(SCROLL_OBSERVATION_HOST).toContain('distanceFromLiveTailForReleasePx: input.distanceFromLiveTailForReleasePx');
        expect(SCROLL_OBSERVATION_HOST).toContain('distanceFromLiveTailPx: input.distanceFromLiveTailPx');
        expect(SCROLL_OBSERVATION_HOST).not.toContain('canRelease:');
        expect(SCROLL_OBSERVATION_HOST).not.toContain("direction: 'toward-max'");
    });

    it('routes native scroll facts observation shaping through the lifecycle owner', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);

        expect(existsSync(SCROLL_OBSERVATION_HOST_URL)).toBe(true);
        expect(onScrollSource).not.toContain('resolveNativeScrollFactsObservationEffects({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollFactsObservationEffects({');
        expect(SCROLL_OBSERVATION_HOST).toContain('dispatch: lifecycle.dispatch');
        expect(CHATLIST).not.toContain('const updateNativeBottomFollowModeFromScrollObservation = React.useCallback');
        expect(onScrollSource).not.toContain("type: 'facts-observed'");
        expect(onScrollSource).not.toContain("movement: 'away-from-live-tail'");
        expect(onScrollSource).not.toContain("movement: 'toward-live-tail'");
        expect(onScrollSource).not.toContain("movement: 'none'");
        expect(NATIVE_SCROLL_FACTS_OBSERVATION).toContain('resolveNativeScrollFactsObservationEffects');
    });

    it('routes active web and native scroll-observation arbitration through the lifecycle host', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);

        const observeScrollCalls = onScrollSource.match(/scrollObservationHost\.observeScroll\(\{/g) ?? [];

        expect(existsSync(SCROLL_OBSERVATION_HOST_URL)).toBe(true);
        expect(CHATLIST).not.toContain("from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent'");
        expect(onScrollSource).not.toContain('resolveTranscriptBottomFollowIntent({');
        expect(observeScrollCalls).toHaveLength(2);
        expect(onScrollSource).toContain("platform: 'web'");
        expect(onScrollSource).toContain("platform: 'native'");
        expect(onScrollSource).toContain('hasLiveWebMetrics: liveWebMetrics != null');
        expect(onScrollSource).not.toContain('observeWebBottomFollowFactsWithLifecycle({');
        expect(onScrollSource).not.toContain('resolveActiveWebScrollFallbackObservationEffects({');
        expect(onScrollSource).not.toContain('resolveWebScrollObservationGenericLifecycleEffects({');
        expect(onScrollSource).not.toContain('resolveNativeScrollFollowIntent({');
        expect(onScrollSource).not.toContain('resolveNativeScrollAwayGestureLiveTailBailDecision({');
        expect(onScrollSource).not.toContain('resolveNativeScrollObservationAnchorCaptureSuppression({');
        expect(onScrollSource).not.toContain('resolveNativeScrollReadOnlyVisibleBottomDecision({');
        expect(onScrollSource).not.toContain('resolveNativeScrollPassiveDriftBailDecision({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveActiveWebScrollFallbackObservationEffects({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveWebScrollObservationGenericLifecycleEffects({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollFollowIntent({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollAwayGestureLiveTailBailDecision({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollObservationAnchorCaptureSuppression({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollReadOnlyVisibleBottomDecision({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollPassiveDriftBailDecision({');
        expect(WEB_SCROLL_FACTS_OBSERVATION).toContain('resolveWebScrollFactsObservationEffects');
        expect(WEB_SCROLL_OBSERVATION_GENERIC_EFFECT).toContain('resolveWebScrollObservationGenericLifecycleEffects');
        expect(WEB_SCROLL_FALLBACK_FOLLOW_INTENT).toContain('resolveTranscriptBottomFollowIntent');
    });

    it('routes active web user-scroll intent side effects through lifecycle appliers', () => {
        const stopScrollSource = CHATLIST.match(
            /const stopScrollEventPropagationOnWeb = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const markUserScrollSource = CHATLIST.match(
            /const markUserScrollIntentOnWeb = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);

        expect(CHATLIST).toContain('resolveWebUserScrollTakeoverApplyEffects');
        expect(CHATLIST).toContain('resolveWebUserScrollIntentTimestampApplyEffects');
        expect(CHATLIST).toContain('resolveWebImmediateReleaseLiveTailApplyEffects');
        expect(CHATLIST).toContain('const applyWebUserScrollTakeoverLifecycleEffects = React.useCallback');
        expect(CHATLIST).toContain('const applyWebUserScrollIntentTimestampLifecycleEffects = React.useCallback');
        expect(CHATLIST).toContain('const releaseLiveTailForImmediateWebUserIntent = React.useCallback');
        expect(CHATLIST).toContain('const observeWebGenuineScrollMovement = React.useCallback');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveWebUserScrollTakeoverApplyEffects');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveWebUserScrollIntentTimestampApplyEffects');

        expect(stopScrollSource).toContain("type: 'web-user-scroll-takeover'");
        expect(stopScrollSource).toContain("type: 'web-user-scroll-intent-timestamp'");
        expect(stopScrollSource).toContain('applyWebUserScrollTakeoverLifecycleEffects(transition.effects)');
        expect(stopScrollSource).toContain('applyWebUserScrollIntentTimestampLifecycleEffects(timestampTransition.effects)');
        expect(stopScrollSource).toContain('releaseLiveTailForImmediateWebUserIntent()');
        expect(stopScrollSource).not.toContain('preemptEntryRestoreTransaction()');
        expect(stopScrollSource).not.toContain('lastUserScrollIntentAtMsRef.current =');
        expect(stopScrollSource).not.toContain('wantsPinnedRef.current = false');

        expect(markUserScrollSource).toContain("type: 'web-user-scroll-takeover'");
        expect(markUserScrollSource).toContain("type: 'web-user-scroll-intent-timestamp'");
        expect(markUserScrollSource).toContain('applyWebUserScrollTakeoverLifecycleEffects(transition.effects)');
        expect(markUserScrollSource).toContain('applyWebUserScrollIntentTimestampLifecycleEffects(timestampTransition.effects)');
        expect(markUserScrollSource).not.toContain('preemptEntryRestoreTransaction()');
        expect(markUserScrollSource).not.toContain('lastUserScrollIntentAtMsRef.current =');

        expect(onScrollSource).toContain('observeWebGenuineScrollMovement({');
        expect(onScrollSource).toContain('webObservedUpwardIntent,');
        expect(onScrollSource).toContain('webObservedUserScrollMovement,');
        expect(onScrollSource).not.toContain('webDomObservation.observeGenuineScrollMovement({');
        expect(onScrollSource).not.toContain("type: 'web-user-scroll-takeover'");
        expect(onScrollSource).not.toContain("type: 'web-user-scroll-intent-timestamp'");
        expect(onScrollSource).not.toContain('webObservedUserScrollMovement = true');
        expect(onScrollSource).not.toContain('lastUserScrollIntentAtMsRef.current = nowMs');
        expect(onScrollSource).not.toContain('wantsPinnedRef.current = false');
    });

    it('routes native user-scroll takeover side effects through lifecycle appliers', () => {
        const recordNativeUserScrollIntentSource = CHATLIST.match(
            /const recordNativeUserScrollIntent = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(recordNativeUserScrollIntentSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveNativeUserScrollTakeoverApplyEffects');
        expect(CHATLIST).toContain('type NativeUserScrollTakeoverApplyEffect');
        expect(CHATLIST).toContain('const applyNativeUserScrollTakeoverApplyEffects = React.useCallback');
        expect(CHATLIST).toContain('const applyNativeUserScrollTakeoverLifecycleEffects = React.useCallback');

        expect(recordNativeUserScrollIntentSource).toContain("type: 'native-user-scroll-takeover'");
        expect(recordNativeUserScrollIntentSource).toContain('timestampMs: nowMs');
        expect(recordNativeUserScrollIntentSource).toContain('applyNativeUserScrollTakeoverLifecycleEffects(transition.effects)');
        expect(recordNativeUserScrollIntentSource).not.toContain('preemptEntryRestoreTransaction()');
        expect(recordNativeUserScrollIntentSource).not.toContain('lastUserScrollIntentAtMsRef.current = nowMs');
        expect(recordNativeUserScrollIntentSource).not.toContain('pendingNativeMountSettleBottomPinRef.current = false');
        expect(recordNativeUserScrollIntentSource).not.toContain('nativeMountSettleAutoPinSuppressedRef.current = true');
        expect(recordNativeUserScrollIntentSource).not.toContain('updateNativeInitialViewportPendingObservation(false)');
    });

    it('routes native touch intent side effects through lifecycle appliers', () => {
        const recordNativeTranscriptTouchIntentSource = CHATLIST.match(
            /const recordNativeTranscriptTouchIntent = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(recordNativeTranscriptTouchIntentSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveNativeTouchIntentApplyEffects');
        expect(CHATLIST).toContain('type NativeTouchIntentApplyEffect');
        expect(CHATLIST).toContain('const applyNativeTouchIntentApplyEffects = React.useCallback');
        expect(CHATLIST).toContain('const applyNativeTouchIntentLifecycleEffects = React.useCallback');

        expect(recordNativeTranscriptTouchIntentSource).toContain("type: 'native-touch-intent'");
        expect(recordNativeTranscriptTouchIntentSource).toContain('hasActiveNativeViewportRestore: hasActiveNativeRestore');
        expect(recordNativeTranscriptTouchIntentSource).toContain('timestampMs: Date.now()');
        expect(recordNativeTranscriptTouchIntentSource).toContain('applyNativeTouchIntentLifecycleEffects(transition.effects)');
        expect(recordNativeTranscriptTouchIntentSource).not.toContain('lastUserScrollIntentAtMsRef.current = Date.now()');
        expect(recordNativeTranscriptTouchIntentSource).not.toContain('nativeMountSettleAutoPinSuppressedRef.current = true');
        expect(recordNativeTranscriptTouchIntentSource).not.toContain('pendingNativeMountSettleBottomPinRef.current = false');
        expect(recordNativeTranscriptTouchIntentSource).not.toContain('cancelScheduledPinToBottom()');
    });

    it('routes native touch escape release through lifecycle appliers', () => {
        const recordNativeTranscriptTouchIntentSource = CHATLIST.match(
            /const recordNativeTranscriptTouchIntent = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(recordNativeTranscriptTouchIntentSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveNativeTouchReleaseLiveTailStateEffects');
        expect(CHATLIST).toContain('type NativeTouchReleaseLiveTailStateEffect');
        expect(CHATLIST).toContain('const applyNativeTouchReleaseLiveTailStateEffects = React.useCallback');
        expect(CHATLIST).toContain('const applyNativeTouchReleaseLifecycleEffects = React.useCallback');

        expect(recordNativeTranscriptTouchIntentSource).toContain("type: 'facts-observed'");
        expect(recordNativeTranscriptTouchIntentSource).toContain("source: 'native-touch-escape'");
        expect(recordNativeTranscriptTouchIntentSource).toContain("movement: 'away-from-live-tail'");
        expect(recordNativeTranscriptTouchIntentSource).toContain('trustedUserMovement: true');
        expect(recordNativeTranscriptTouchIntentSource).toContain('distanceFromLiveTailPx: releaseThresholdPx + 1');
        expect(recordNativeTranscriptTouchIntentSource).toContain('applyNativeTouchReleaseLifecycleEffects(transition.effects)');
        expect(recordNativeTranscriptTouchIntentSource).not.toContain('releaseNativeBottomFollowForGestureIntent()');
    });

    it('routes native offset escape release through the lifecycle host', () => {
        const offsetEscapeSource = CHATLIST.match(
            /const releaseNativeBottomFollowIfFlashListOffsetEscaped = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(offsetEscapeSource).not.toEqual('');
        expect(CHATLIST).toContain('lifecycleHost.planNativeOffsetEscapeRelease');
        expect(CHATLIST).not.toContain('resolveNativeOffsetEscapeReleaseDecision');
        expect(CHATLIST).not.toContain('resolveNativeOffsetReleaseLiveTailStateEffects');
        expect(CHATLIST).toContain('type NativeOffsetReleaseLiveTailStateEffect');
        expect(CHATLIST).toContain('const applyNativeOffsetReleaseLiveTailStateEffects = React.useCallback');

        expect(offsetEscapeSource).toContain('lifecycleHost.planNativeOffsetEscapeRelease({');
        expect(offsetEscapeSource).toContain('applyNativeGestureTakeoverPlan(plan.nativeGestureTakeoverPlan)');
        expect(offsetEscapeSource).toContain(
            'return applyNativeOffsetReleaseLiveTailStateEffects(plan.nativeOffsetReleaseLiveTailStateEffects)',
        );
        expect(offsetEscapeSource).not.toContain("source: 'native-offset-escape'");
        expect(offsetEscapeSource).not.toContain("movement: 'away-from-live-tail'");
        expect(offsetEscapeSource).not.toContain('trustedUserMovement: true');
        expect(offsetEscapeSource).not.toContain('beginNativeBottomFollowGestureIntent()');
        expect(offsetEscapeSource).not.toContain('releaseNativeBottomFollowForGestureIntent()');
        expect(offsetEscapeSource).not.toContain('wantsPinnedRef.current = false');
        expect(offsetEscapeSource).not.toContain('isPinnedRef.current = false');

        expect(LIFECYCLE_HOST).toContain('planNativeOffsetEscapeRelease');
        expect(LIFECYCLE_HOST).toContain('resolveNativeOffsetReleaseLiveTailStateEffects');
        expect(NATIVE_OFFSET_ESCAPE_RELEASE).toContain('resolveNativeOffsetEscapeReleaseDecision');
        expect(NATIVE_OFFSET_ESCAPE_RELEASE).toContain('resolveNativeOffsetReleaseLiveTailStateEffects');
    });

    it('routes local transcript interaction auto-pin deferral through lifecycle appliers', () => {
        const deferSource = CHATLIST.match(
            /const deferAutoPinAfterLocalTranscriptInteraction = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const applySource = CHATLIST.match(
            /const applyLocalTranscriptInteractionAutoPinDeferralApplyEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(deferSource).not.toEqual('');
        expect(applySource).not.toEqual('');
        expect(CHATLIST).toContain('resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects');
        expect(CHATLIST).toContain('type LocalTranscriptInteractionAutoPinDeferralApplyEffect');
        expect(CHATLIST).toContain('const applyLocalTranscriptInteractionAutoPinDeferralApplyEffects = React.useCallback');
        expect(CHATLIST).toContain('const applyLocalTranscriptInteractionAutoPinDeferralEffects = React.useCallback');

        expect(deferSource).toContain("type: 'local-transcript-interaction-auto-pin-deferral'");
        expect(deferSource).toContain('timestampMs: nowMs');
        expect(deferSource).toContain('applyLocalTranscriptInteractionAutoPinDeferralEffects(transition.effects)');
        expect(deferSource).not.toContain('lastUserScrollIntentAtMsRef.current = Date.now()');
        expect(deferSource).not.toContain('nativeMountSettleAutoPinSuppressedRef.current = true');
        expect(deferSource).not.toContain('cancelScheduledPinToBottom()');

        expect(applySource).toContain("case 'local-interaction-record-intent-timestamp':");
        expect(applySource).toContain('lastUserScrollIntentAtMsRef.current = effect.timestampMs');
        expect(applySource).toContain("case 'local-interaction-suppress-native-mount-settle-auto-pin':");
        expect(applySource).toContain('nativeMountSettleAutoPinSuppressedRef.current = true');
        expect(applySource).toContain("case 'local-interaction-cancel-scheduled-pin':");
        expect(applySource).toContain('cancelScheduledPinToBottom()');

        expect(LOCAL_TRANSCRIPT_INTERACTION_AUTO_PIN_DEFERRAL)
            .toContain('resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects');
    });

    it('consumes native bottom-follow rearm adoption through lifecycle effects', () => {
        const dragEndSource = CHATLIST.match(
            /const recordNativeListDragEndIntent = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const momentumSettleSource = CHATLIST.match(
            /const recordNativeMomentumScrollEndSettle = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const adoptionApplierSource = CHATLIST.match(
            /const applyNativeBottomFollowRearmAdoptionEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const lifecycleApplierSource = CHATLIST.match(
            /const applyNativeBottomFollowRearmLifecycleEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(dragEndSource).not.toEqual('');
        expect(momentumSettleSource).not.toEqual('');
        expect(adoptionApplierSource).not.toEqual('');
        expect(lifecycleApplierSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveNativeBottomFollowRearmAdoptionDecision');
        expect(CHATLIST).toContain('type NativeBottomFollowRearmAdoptionEffect');

        expect(dragEndSource).toContain('applyNativeReturnToLiveTailLifecycleEffects(transition.effects)');
        expect(dragEndSource).toContain('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)');
        expect(dragEndSource.indexOf('applyNativeReturnToLiveTailLifecycleEffects(transition.effects)')).toBeLessThan(
            dragEndSource.indexOf('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)'),
        );
        expect(dragEndSource).not.toContain("transition.state.followMode === 'following'");
        expect(dragEndSource).not.toContain('adoptNativeFollowingForTrustedBottomArrival(');

        expect(momentumSettleSource).toContain('applyNativeReturnToLiveTailLifecycleEffects(transition.effects)');
        expect(momentumSettleSource).toContain('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)');
        expect(momentumSettleSource.indexOf('applyNativeReturnToLiveTailLifecycleEffects(transition.effects)')).toBeLessThan(
            momentumSettleSource.indexOf('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)'),
        );
        expect(momentumSettleSource).not.toContain("transition.state.followMode === 'following'");
        expect(momentumSettleSource).not.toContain('adoptNativeFollowingForTrustedBottomArrival(');

        expect(adoptionApplierSource).toContain('if (effect.sessionId !== props.sessionId) continue');
        expect(adoptionApplierSource).toContain('adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx)');
        expect(adoptionApplierSource).not.toContain('nativeBottomFollowRearmedAfterDragRef.current');
        expect(adoptionApplierSource).not.toContain('wantsPinnedRef.current');
        expect(adoptionApplierSource).not.toContain('isPinnedRef.current');
        expect(adoptionApplierSource).not.toContain('emitViewportChange(');
        expect(adoptionApplierSource).not.toContain('scheduleViewportAnchorCapture(');
        expect(lifecycleApplierSource).toContain('resolveNativeBottomFollowRearmAdoptionDecision({');
        expect(NATIVE_BOTTOM_FOLLOW_REARM_ADOPTION).toContain('resolveNativeBottomFollowRearmAdoptionDecision');
    });

    it('consumes native bottom-follow rearm reset through lifecycle effects', () => {
        const gestureStartSource = CHATLIST.match(
            /const beginNativeBottomFollowGestureIntent = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const touchIntentSource = CHATLIST.match(
            /const recordNativeTranscriptTouchIntent = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const dragEndSource = CHATLIST.match(
            /const recordNativeListDragEndIntent = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const momentumSettleSource = CHATLIST.match(
            /const recordNativeMomentumScrollEndSettle = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const resetApplierSource = CHATLIST.match(
            /const applyNativeBottomFollowRearmResetEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const lifecycleResetApplierSource = CHATLIST.match(
            /const applyNativeBottomFollowRearmResetLifecycleEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(gestureStartSource).not.toEqual('');
        expect(touchIntentSource).not.toEqual('');
        expect(dragEndSource).not.toEqual('');
        expect(momentumSettleSource).not.toEqual('');
        expect(resetApplierSource).not.toEqual('');
        expect(lifecycleResetApplierSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveNativeBottomFollowRearmResetEffects');
        expect(CHATLIST).toContain('type NativeBottomFollowRearmResetEffect');

        expect(gestureStartSource).toContain('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)');
        expect(gestureStartSource).not.toContain('nativeBottomFollowRearmedAfterDragRef.current = false');

        expect(touchIntentSource).toContain('applyNativeTouchReleaseLifecycleEffects(transition.effects)');
        expect(touchIntentSource).toContain('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)');
        expect(touchIntentSource.indexOf('applyNativeTouchReleaseLifecycleEffects(transition.effects)')).toBeLessThan(
            touchIntentSource.indexOf('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)'),
        );

        expect(dragEndSource).toContain('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)');
        expect(dragEndSource).toContain('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)');
        expect(dragEndSource.indexOf('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)')).toBeLessThan(
            dragEndSource.indexOf('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)'),
        );
        expect(dragEndSource).not.toContain('nativeBottomFollowRearmedAfterDragRef.current = false');

        expect(momentumSettleSource).toContain('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)');
        expect(momentumSettleSource).toContain('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)');
        expect(momentumSettleSource.indexOf('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)')).toBeLessThan(
            momentumSettleSource.indexOf('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)'),
        );

        expect(resetApplierSource).toContain('if (effect.sessionId !== props.sessionId) continue');
        expect(resetApplierSource).toContain("case 'reset-native-bottom-follow-rearm':");
        expect(resetApplierSource).toContain('nativeBottomFollowRearmedAfterDragRef.current = false');
        expect(resetApplierSource).not.toContain('wantsPinnedRef');
        expect(resetApplierSource).not.toContain('isPinnedRef');
        expect(resetApplierSource).not.toContain('lastPinOffsetForIntentRef');
        expect(resetApplierSource).not.toContain('adoptNativeFollowingForTrustedBottomArrival');
        expect(resetApplierSource).not.toContain('commitJumpToBottomDistanceForVisibility');
        expect(resetApplierSource).not.toContain('commitScrollPinEvent');
        expect(resetApplierSource).not.toContain('emitViewportChange');
        expect(resetApplierSource).not.toContain('drainDeferredNewerMessages');
        expect(resetApplierSource).not.toContain('scheduleViewportAnchorCaptureRef');
        expect(resetApplierSource).not.toContain('executeViewportCommand');

        expect(lifecycleResetApplierSource).toContain('resolveNativeBottomFollowRearmResetEffects({');
        expect(lifecycleResetApplierSource).toContain('effects,');
        expect(lifecycleResetApplierSource).toContain('sessionId: props.sessionId');
        expect(NATIVE_BOTTOM_FOLLOW_REARM_RESET).toContain('resolveNativeBottomFollowRearmResetEffects');
    });

    it('consumes native momentum settle-away release state through lifecycle effects', () => {
        const momentumSettleSource = CHATLIST.match(
            /const recordNativeMomentumScrollEndSettle = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const releaseStateApplierSource = CHATLIST.match(
            /const applyNativeMomentumSettleAwayReleaseStateEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const releaseLifecycleApplierSource = CHATLIST.match(
            /const applyNativeMomentumSettleAwayReleaseLifecycleEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(momentumSettleSource).not.toEqual('');
        expect(releaseStateApplierSource).not.toEqual('');
        expect(releaseLifecycleApplierSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveNativeMomentumSettleAwayReleaseStateEffects');
        expect(CHATLIST).toContain('type NativeMomentumSettleAwayReleaseStateEffect');

        expect(momentumSettleSource).toContain('applyNativeReturnToLiveTailLifecycleEffects(transition.effects)');
        expect(momentumSettleSource).toContain('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)');
        expect(momentumSettleSource).toContain('applyNativeMomentumSettleAwayReleaseLifecycleEffects(transition.effects)');
        expect(momentumSettleSource).toContain('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)');
        expect(momentumSettleSource.indexOf('applyNativeReturnToLiveTailLifecycleEffects(transition.effects)')).toBeLessThan(
            momentumSettleSource.indexOf('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)'),
        );
        expect(momentumSettleSource.indexOf('applyNativeBottomFollowRearmLifecycleEffects(transition.effects)')).toBeLessThan(
            momentumSettleSource.indexOf('applyNativeMomentumSettleAwayReleaseLifecycleEffects(transition.effects)'),
        );
        expect(momentumSettleSource.indexOf('applyNativeMomentumSettleAwayReleaseLifecycleEffects(transition.effects)')).toBeLessThan(
            momentumSettleSource.indexOf('applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects)'),
        );
        expect(momentumSettleSource).not.toContain('const settledDistanceFromBottom =');
        expect(momentumSettleSource).not.toContain('wantsPinnedRef.current = false');
        expect(momentumSettleSource).not.toContain('isPinnedRef.current = false');
        expect(momentumSettleSource).not.toContain('lastPinOffsetForIntentRef.current = settledDistanceFromBottom');
        expect(momentumSettleSource).not.toContain('commitJumpToBottomDistanceForVisibility(settledDistanceFromBottom)');
        expect(momentumSettleSource).not.toContain('setScrollPin((prev)');
        expect(momentumSettleSource).not.toContain('emitViewportChange(settledViewportState)');
        expect(momentumSettleSource).not.toContain('scheduleViewportAnchorCaptureRef.current(settledViewportState)');

        expect(releaseLifecycleApplierSource).toContain('resolveNativeMomentumSettleAwayReleaseStateEffects({');
        expect(releaseLifecycleApplierSource).toContain('effects,');
        expect(releaseLifecycleApplierSource).toContain('sessionId: props.sessionId');
        expect(releaseLifecycleApplierSource).toContain('wantsPinned: wantsPinnedRef.current');
        expect(releaseLifecycleApplierSource).toContain('pinEnabled,');

        expect(releaseStateApplierSource).toContain('if (effect.sessionId !== props.sessionId) continue');
        expect(releaseStateApplierSource).toContain("effect.type !== 'apply-native-momentum-settle-away-release-state'");
        expect(releaseStateApplierSource).toContain('wantsPinnedRef.current = false');
        expect(releaseStateApplierSource).toContain('isPinnedRef.current = false');
        expect(releaseStateApplierSource).toContain('cancelScheduledPinToBottom()');
        expect(releaseStateApplierSource).toContain('lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx');
        expect(releaseStateApplierSource).toContain('commitJumpToBottomDistanceForVisibility(effect.distanceFromLiveTailPx)');
        expect(releaseStateApplierSource).toContain('reduceTranscriptScrollPinState(prev, effect.scrollPinEvent)');
        expect(releaseStateApplierSource).toContain('emitViewportChange(effect.viewportState)');
        expect(releaseStateApplierSource).toContain('scheduleViewportAnchorCaptureRef.current(effect.viewportState)');
        expect(releaseStateApplierSource).not.toContain('drainDeferredNewerMessages');
        expect(releaseStateApplierSource).not.toContain('recordAcceptedViewportPaintObservation');
        expect(releaseStateApplierSource).not.toContain('executeViewportCommand');
        expect(releaseStateApplierSource).not.toContain('adoptNativeFollowingForTrustedBottomArrival');
        expect(releaseStateApplierSource).not.toContain('nativeBottomFollowRearmedAfterDragRef.current');

        expect(NATIVE_MOMENTUM_SETTLE_AWAY_RELEASE)
            .toContain('resolveNativeMomentumSettleAwayReleaseStateEffects');
    });

    it('applies native trusted bottom arrival through a typed lifecycle helper', () => {
        const adoptionHelperSource = CHATLIST.match(
            /const adoptNativeFollowingForTrustedBottomArrival = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const trustedArrivalApplierSource = CHATLIST.match(
            /const applyNativeTrustedBottomArrivalEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(adoptionHelperSource).not.toEqual('');
        expect(trustedArrivalApplierSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveNativeTrustedBottomArrivalEffects');
        expect(CHATLIST).toContain('type NativeTrustedBottomArrivalEffect');

        expect(adoptionHelperSource).toContain("if (Platform.OS === 'web') return");
        expect(adoptionHelperSource).toContain('applyNativeTrustedBottomArrivalEffects(resolveNativeTrustedBottomArrivalEffects({');
        expect(adoptionHelperSource).toContain('distanceFromLiveTailPx: distanceFromBottom');
        expect(adoptionHelperSource).toContain('sessionId: props.sessionId');
        expect(adoptionHelperSource).not.toContain('lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY');
        expect(adoptionHelperSource).not.toContain('nativeMountSettleAutoPinSuppressedRef.current = false');
        expect(adoptionHelperSource).not.toContain('nativeBottomFollowRearmedAfterDragRef.current = true');
        expect(adoptionHelperSource).not.toContain('wantsPinnedRef.current = true');
        expect(adoptionHelperSource).not.toContain('isPinnedRef.current = true');
        expect(adoptionHelperSource).not.toContain('lastPinOffsetForIntentRef.current');
        expect(adoptionHelperSource).not.toContain('commitJumpToBottomDistanceForVisibility(');
        expect(adoptionHelperSource).not.toContain('setScrollPin((prev)');
        expect(adoptionHelperSource).not.toContain('emitViewportChange(');

        expect(trustedArrivalApplierSource).toContain('if (effect.sessionId !== props.sessionId) continue');
        expect(trustedArrivalApplierSource).toContain("effect.type !== 'adopt-native-trusted-bottom-arrival'");
        expect(trustedArrivalApplierSource).toContain('lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY');
        expect(trustedArrivalApplierSource).toContain('nativeMountSettleAutoPinSuppressedRef.current = false');
        expect(trustedArrivalApplierSource).toContain('nativeBottomFollowRearmedAfterDragRef.current = true');
        expect(trustedArrivalApplierSource).toContain('wantsPinnedRef.current = true');
        expect(trustedArrivalApplierSource).toContain('isPinnedRef.current = true');
        expect(trustedArrivalApplierSource).toContain('lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx');
        expect(trustedArrivalApplierSource).toContain('commitJumpToBottomDistanceForVisibility(effect.distanceFromLiveTailPx)');
        expect(trustedArrivalApplierSource).toContain('setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }))');
        expect(trustedArrivalApplierSource).toContain('emitViewportChange(effect.viewportState)');
        expect(trustedArrivalApplierSource).not.toContain('drainDeferredNewerMessages');
        expect(trustedArrivalApplierSource).not.toContain('scheduleViewportAnchorCaptureRef');
        expect(trustedArrivalApplierSource).not.toContain('executeViewportCommand');
        expect(trustedArrivalApplierSource).not.toContain('pinToBottom');
        const sessionFilterIndex = trustedArrivalApplierSource.indexOf('if (effect.sessionId !== props.sessionId) continue');
        for (const writeStatement of [
            'lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY',
            'commitJumpToBottomDistanceForVisibility(effect.distanceFromLiveTailPx)',
            'setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }))',
            'emitViewportChange(effect.viewportState)',
        ]) {
            expect(sessionFilterIndex).toBeGreaterThanOrEqual(0);
            expect(sessionFilterIndex).toBeLessThan(trustedArrivalApplierSource.indexOf(writeStatement));
        }

        expect(NATIVE_TRUSTED_BOTTOM_ARRIVAL).toContain('resolveNativeTrustedBottomArrivalEffects');
    });

    it('applies native settled-return anchor capture through a typed lifecycle helper', () => {
        const settledReturnApplierSource = CHATLIST.match(
            /const applyNativeSettledReturnToLiveTailReturnEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const anchorCaptureApplierSource = CHATLIST.match(
            /const applyNativeSettledReturnAnchorCaptureEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(settledReturnApplierSource).not.toEqual('');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).not.toEqual('');
        expect(anchorCaptureApplierSource).not.toEqual('');
        expect(CHATLIST).not.toContain('resolveNativeSettledReturnToLiveTailApplyEffects');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeSettledReturnToLiveTailApplyEffects');
        expect(CHATLIST).toContain('type NativeSettledReturnToLiveTailReturnEffect');
        expect(CHATLIST).not.toContain('resolveNativeSettledReturnAnchorCaptureEffects');
        expect(CHATLIST).toContain('type NativeSettledReturnAnchorCaptureEffect');

        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('const settledReturnEffects = plan.nativeSettledReturnEffects');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('callbacks.applyNativeAcceptedViewportPaintEffects(plan.acceptedViewportPaintEffects)');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('callbacks.applyNativeSettledReturnToLiveTailReturnEffects(settledReturnEffects.returnEffects)');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('callbacks.applyNativeSettledReturnToLiveTailDrainEffects(settledReturnEffects.drainEffects)');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('callbacks.applyNativeAcceptedViewportPaintEffects(plan.acceptedViewportPaintEffects)')).toBeLessThan(
            SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('callbacks.applyNativeSettledReturnToLiveTailReturnEffects(settledReturnEffects.returnEffects)'),
        );
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('callbacks.applyNativeSettledReturnToLiveTailReturnEffects(settledReturnEffects.returnEffects)')).toBeLessThan(
            SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('callbacks.applyNativeSettledReturnToLiveTailDrainEffects(settledReturnEffects.drainEffects)'),
        );
        expect(settledReturnApplierSource).toContain("effect.type === 'adopt-native-settled-return-to-live-tail'");
        expect(settledReturnApplierSource).toContain('adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx)');
        expect(settledReturnApplierSource).toContain("effect.type === 'capture-native-settled-return-anchor'");
        expect(settledReturnApplierSource).toContain('applyNativeSettledReturnAnchorCaptureEffects([effect])');
        expect(settledReturnApplierSource.indexOf('adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx)')).toBeLessThan(
            settledReturnApplierSource.indexOf('applyNativeSettledReturnAnchorCaptureEffects([effect])'),
        );
        expect(settledReturnApplierSource).not.toContain('drainDeferredNewerMessages');
        expect(settledReturnApplierSource).not.toContain('executeViewportCommand');

        expect(anchorCaptureApplierSource).toContain('if (effect.sessionId !== props.sessionId) continue');
        expect(anchorCaptureApplierSource).toContain("effect.type !== 'capture-native-settled-return-anchor'");
        expect(anchorCaptureApplierSource).toContain('scheduleViewportAnchorCaptureRef.current(effect.viewportState)');
        expect(anchorCaptureApplierSource).not.toContain('adoptNativeFollowingForTrustedBottomArrival');
        expect(anchorCaptureApplierSource).not.toContain('drainDeferredNewerMessages');
        expect(anchorCaptureApplierSource).not.toContain('emitViewportChange');
        expect(anchorCaptureApplierSource).not.toContain('executeViewportCommand');

        const sessionFilterIndex = anchorCaptureApplierSource.indexOf('if (effect.sessionId !== props.sessionId) continue');
        expect(sessionFilterIndex).toBeGreaterThanOrEqual(0);
        expect(sessionFilterIndex).toBeLessThan(
            anchorCaptureApplierSource.indexOf('scheduleViewportAnchorCaptureRef.current(effect.viewportState)'),
        );

        expect(NATIVE_SETTLED_RETURN_ANCHOR_CAPTURE)
            .toContain('resolveNativeSettledReturnAnchorCaptureEffects');
        expect(NATIVE_RETURN_TO_LIVE_TAIL)
            .toContain('resolveNativeSettledReturnToLiveTailApplyEffects');
        expect(NATIVE_RETURN_TO_LIVE_TAIL)
            .toContain('resolveNativeSettledReturnAnchorCaptureEffects');
    });

    it('routes native confirmation ownership through the lifecycle host', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);
        const explicitJumpApplierSource = CHATLIST.match(
            /const applyNativeExplicitJumpConfirmationEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const entrySettleApplierSource = CHATLIST.match(
            /const applyNativeEntrySettleConfirmationEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const nativeConfirmationObserverSource = CHATLIST.match(
            /const observeNativeConfirmation = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const jumpToBottomSource = CHATLIST.match(
            /const jumpToBottom = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(explicitJumpApplierSource).not.toEqual('');
        expect(entrySettleApplierSource).not.toEqual('');
        expect(nativeConfirmationObserverSource).not.toEqual('');
        expect(jumpToBottomSource).not.toEqual('');
        expect(CHATLIST).toContain("from '@/components/sessions/transcript/viewport/lifecycle/nativeConfirmationOwner'");
        expect(CHATLIST).toContain('NativeExplicitJumpConfirmationEffect');
        expect(CHATLIST).toContain('NativeEntrySettleConfirmationEffect');
        expect(CHATLIST).not.toContain('resolveNativeExplicitJumpConfirmationEffects');
        expect(CHATLIST).not.toContain('createNativeExplicitJumpConfirmationState');
        expect(CHATLIST).not.toContain('resolveNativeEntrySettleConfirmationEffects');
        expect(CHATLIST).not.toContain('createNativeEntrySettleConfirmationState');
        expect(CHATLIST).not.toContain('pendingNativeExplicitJumpConfirmRef');
        expect(CHATLIST).not.toContain('pendingNativeEntrySettleConfirmRef');

        expect(explicitJumpApplierSource).toContain('if (effect.sessionId !== props.sessionId)');
        expect(explicitJumpApplierSource).toContain("effect.type === 'adopt-live-tail-arrival'");
        expect(explicitJumpApplierSource).toContain('adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromBottom)');
        expect(explicitJumpApplierSource).toContain("effect.type === 'issue-reconfirm-jump-to-bottom'");
        expect(explicitJumpApplierSource).toContain("type: 'jump-to-bottom'");
        expect(explicitJumpApplierSource).not.toContain('pendingNativeExplicitJumpConfirmRef.current');
        expect(explicitJumpApplierSource).not.toContain('pendingNativeEntrySettleConfirmRef');

        expect(entrySettleApplierSource).toContain('effect.sessionId !== props.sessionId');
        expect(entrySettleApplierSource).toContain("'issue-entry-settle-reconfirm-pin'");
        expect(entrySettleApplierSource).toContain('pinNativeFlashListToBottomIfMeasured({');
        expect(entrySettleApplierSource).toContain("reason: 'mount-settle'");
        expect(entrySettleApplierSource).not.toContain('pendingNativeEntrySettleConfirmRef');

        expect(nativeConfirmationObserverSource).toContain('lifecycleHost.observeNativeScrollConfirmation({');
        expect(nativeConfirmationObserverSource).toContain('bottomFollowMode: bottomFollowModeStateRef.current.mode');
        expect(nativeConfirmationObserverSource).toContain('applyNativeExplicitJumpConfirmationEffects(plan.explicitJumpEffects)');
        expect(nativeConfirmationObserverSource).toContain('applyNativeEntrySettleConfirmationEffects(plan.entrySettleEffects)');
        expect(nativeConfirmationObserverSource).toContain('return plan.consumed');

        expect(jumpToBottomSource).toContain('lifecycleHost.armNativeExplicitJumpConfirmation({');
        expect(jumpToBottomSource).toContain('lifecycleHost.clearNativeExplicitJumpConfirmation({');
        expect(jumpToBottomSource).toContain('issuedContentHeight: listContentHeightRef.current');

        expect(onScrollSource).toContain('observeNativeConfirmation({');
        expect(onScrollSource).not.toContain('const pendingExplicitJump = pendingNativeExplicitJumpConfirmRef.current');
        expect(onScrollSource).not.toContain('contentH !== pendingExplicitJump.issuedContentHeight');
        expect(onScrollSource).not.toContain('const pendingEntrySettle = pendingNativeEntrySettleConfirmRef.current');
        expect(onScrollSource).not.toContain('contentH > pendingEntrySettle.issuedContentHeight');

        expect(NATIVE_CONFIRMATION_OWNER).toContain('resolveNativeExplicitJumpConfirmationEffects');
        expect(NATIVE_CONFIRMATION_OWNER).toContain('resolveNativeEntrySettleConfirmationEffects');
        expect(NATIVE_CONFIRMATION_OWNER).toContain('if (explicitResult.consumed)');
        expect(NATIVE_CONFIRMATION_OWNER.indexOf('resolveNativeExplicitJumpConfirmationEffects')).toBeLessThan(
            NATIVE_CONFIRMATION_OWNER.indexOf('resolveNativeEntrySettleConfirmationEffects'),
        );
        expect(NATIVE_EXPLICIT_JUMP_CONFIRMATION)
            .toContain('resolveNativeExplicitJumpConfirmationEffects');
        expect(NATIVE_ENTRY_SETTLE_CONFIRMATION)
            .toContain('resolveNativeEntrySettleConfirmationEffects');
    });

    it('routes session-entry resets through the latch arm plan and lifecycle selector/applier', () => {
        const sessionEntryStart = CHATLIST.indexOf('const sessionViewport = readSessionViewportForEntry(props.sessionId);');
        const sessionEntryEnd = CHATLIST.indexOf('const pinEnabled =', sessionEntryStart);
        expect(sessionEntryStart).toBeGreaterThanOrEqual(0);
        expect(sessionEntryEnd).toBeGreaterThan(sessionEntryStart);
        const sessionEntrySource = CHATLIST.slice(sessionEntryStart, sessionEntryEnd);
        const armResetSource = CHATLIST.match(
            /const applySessionOpenArmResetPlan = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const applierSource = CHATLIST.match(
            /const applySessionEntryRenderResetEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(applierSource).not.toEqual('');
        expect(armResetSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveSessionEntryRenderResetEffects');
        expect(CHATLIST).toContain('type SessionEntryRenderResetEffects');
        expect(CHATLIST).toContain('sessionOpenLatch.arm({');
        expect(CHATLIST).toContain('applySessionOpenLatchEffectsRef.current(armDecision.effects)');
        expect(sessionEntrySource).toContain("platform: Platform.OS === 'web' ? 'web' : 'native'");
        expect(sessionEntrySource).toContain('const entryKind: SessionOpenEntryKind = props.jumpToSeq != null');
        expect(armResetSource).toContain('resolveSessionEntryRenderResetEffects({');
        expect(sessionEntrySource).toContain('effects: lifecycleEntry.effects');
        expect(armResetSource).toContain('sessionId');
        expect(armResetSource).toContain('applySessionEntryRenderResetEffects(resolveSessionEntryRenderResetEffects({');
        expect(armResetSource).toContain('applySessionEntryViewportLifecycleEffects(entryEffects, entryAnchor)');

        expect(sessionEntrySource).not.toContain('webDomObservation.reset()');
        expect(sessionEntrySource).not.toContain('lastNativePinOffsetRef.current = null');
        expect(sessionEntrySource).not.toContain('nativeListDragActiveRef.current = false');
        expect(sessionEntrySource).not.toContain('lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey');
        expect(sessionEntrySource).not.toContain('resetOlderPaginationRef.current()');
        expect(sessionEntrySource).not.toContain('nativeInitialFollowBottomAppliedSessionRef.current =');
        expect(sessionEntrySource).not.toContain('entryRestoreTransactionRef.current = null');
        expect(sessionEntrySource).not.toContain('invalidateNativePrependTransactionRef.current()');
        expect(sessionEntrySource).not.toContain('pendingNativeExplicitJumpConfirmRef.current = null');
        expect(sessionEntrySource).not.toContain('pendingNativeEntrySettleConfirmRef.current =');
        expect(sessionEntrySource).not.toContain('lastNativeRestoreIndexCommandRef.current = null');
        expect(sessionEntrySource).not.toContain('anchorLookupLoadCountRef.current = 0');
        expect(sessionEntrySource).not.toContain('measurementReconciler.resetForSession(props.sessionId)');
        expect(sessionEntrySource).not.toContain('viewportControllerRef.current!.resetForSession');

        const helperNames = [
            'resetRenderTimeWebDomObservationForSessionEntry',
            'resetRenderTimeNativeBottomPinCommandCacheForSessionEntry',
            'resetRenderTimeNativeStreamAppendContentVersionRecordForSessionEntry',
            'resetRenderTimeNativeGestureMomentumMirrorForSessionEntry',
            'resetRenderTimeActivityKeyBaselineForSessionEntry',
            'resetRenderTimeOlderPaginationForSessionEntry',
            'resetRenderTimeNativeSessionViewportLifecycleForSessionEntry',
            'resetRenderTimeEntryRestoreExitActiveRefsForSessionEntry',
            'resetRenderTimeEntryRestoreLocalStateForSessionEntry',
            'clearRenderTimeEntryRestoreTimeoutsForSessionEntry',
            'invalidateRenderTimeNativePrependTransactionForSessionEntry',
            'resetRenderTimeNativeExplicitJumpConfirmationForSessionEntry',
            'resetRenderTimeNativeEntrySettleConfirmationForSessionEntry',
            'resetRenderTimeNativeIndexScrollCommandCacheForSessionEntry',
            'resetRenderTimeEntryRestoreAnchorLookupForSessionEntry',
            'resetRenderTimeMeasurementReconcilerForSessionEntry',
            'resetRenderTimeViewportCommandControllerForSessionEntry',
        ];

        let previousHelperIndex = -1;
        for (const helperName of helperNames) {
            expect(CHATLIST).toContain(`const ${helperName} = React.useCallback`);
            const helperIndex = applierSource.indexOf(`${helperName}(`);
            expect(helperIndex).toBeGreaterThan(previousHelperIndex);
            previousHelperIndex = helperIndex;
        }

        expect(CHATLIST).toContain('measurementHost.resetForSession({ sessionId: measurementReset.sessionId })');

        for (const directReset of [
            'webDomObservation.reset()',
            'lastNativePinOffsetRef.current = null',
            'nativeListDragActiveRef.current = false',
            'lastNativeStreamAppendPinRef.current = null',
            'lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey',
            'resetOlderPaginationRef.current()',
            'nativeInitialFollowBottomAppliedSessionRef.current = { sessionId: props.sessionId, applied: false }',
            'entryRestoreTransactionRef.current = null',
            'entryRestoreSuppressedRef.current = false',
            'nativeContentMeasurementSessionRef.current =',
            'invalidateNativePrependTransactionRef.current()',
            'pendingNativeExplicitJumpConfirmRef.current = null',
            'pendingNativeEntrySettleConfirmRef.current =',
            'lastNativeRestoreIndexCommandRef.current = null',
            'anchorLookupLoadCountRef.current = 0',
            'measurementReconciler.resetForSession(props.sessionId)',
            'viewportControllerRef.current!.resetForSession',
        ]) {
            expect(applierSource).not.toContain(directReset);
        }

        expect(SESSION_ENTRY_RENDER_RESET_EFFECTS)
            .toContain('resolveSessionEntryRenderResetEffects');
    });

    it('routes entry-restore close and dispose outcomes through the entry restore owner', () => {
        const ownerDisposeSource = CHATLIST.match(
            /const disposeEntryRestoreTransactionForExit = React\.useCallback\([\s\S]*?disposeEntryRestoreTransactionForExitRef\.current = disposeEntryRestoreTransactionForExit;/,
        )?.[0] ?? '';
        const ownerEffectApplierSource = CHATLIST.match(
            /const applyEntryRestoreOwnerEffects = React\.useCallback\([\s\S]*?applyEntryRestoreOwnerEffectsRef\.current = applyEntryRestoreOwnerEffects;/,
        )?.[0] ?? '';
        const disposeEntryRestoreSource = CHATLIST.match(
            /const disposeEntryRestoreTransactionForExit = React\.useCallback\([\s\S]*?disposeEntryRestoreTransactionForExitRef\.current = disposeEntryRestoreTransactionForExit;/,
        )?.[0] ?? '';
        const resetExitRefsSource = CHATLIST.match(
            /const resetRenderTimeEntryRestoreExitActiveRefsForSessionEntry = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]*\]\);/,
        )?.[0] ?? '';
        const unmountCleanupStart = CHATLIST.indexOf('flushViewportAnchorCaptureRef.current();');
        const unmountCleanupEnd = CHATLIST.indexOf('mountSettleCoordinatorRef.current?.reset({ reason: \'unmount\' });', unmountCleanupStart);
        const unmountCleanupSource = CHATLIST.slice(unmountCleanupStart, unmountCleanupEnd);

        expect(ENTRY_RESTORE_CLOSE_EFFECTS).toContain('resolveEntryRestoreCloseEffects');
        expect(ENTRY_RESTORE_CLOSE_EFFECTS).toContain('resolveEntryRestoreDisposeEffects');
        expect(ENTRY_RESTORE_OWNER).toContain('resolveEntryRestoreCloseEffects({');
        expect(ENTRY_RESTORE_OWNER).toContain('resolveEntryRestoreDisposeEffects({');
        expect(CHATLIST).toContain('type EntryRestoreOwnerEffect');
        expect(CHATLIST).toContain('const disposeEntryRestoreTransactionForExitRef = React.useRef');

        expect(ownerEffectApplierSource).not.toEqual('');
        expect(ownerEffectApplierSource).toContain('case \'close-entry-ownership\'');
        expect(ownerEffectApplierSource).toContain('case \'record-restore-decision\'');
        expect(ownerEffectApplierSource).toContain('case \'record-restore-decision-for-session\'');
        expect(ownerEffectApplierSource).toContain('case \'native-initial-viewport-applied\'');
        expect(ownerEffectApplierSource).toContain('case \'schedule-native-entry-paint-release\'');
        expect(ownerEffectApplierSource).not.toContain('resolveEntryRestoreCloseEffects({');
        expect(ownerEffectApplierSource).not.toContain('resolveEntryRestoreDisposeEffects({');

        expect(ownerDisposeSource).not.toEqual('');
        expect(disposeEntryRestoreSource).not.toEqual('');
        expect(disposeEntryRestoreSource).toContain('entryRestoreOwner.disposeForExit({');
        expect(disposeEntryRestoreSource).toContain('applyEntryRestoreOwnerEffects(');
        expect(disposeEntryRestoreSource).not.toContain('recordRestoreDecisionTelemetry(');

        expect(resetExitRefsSource).not.toEqual('');
        expect(resetExitRefsSource).toContain('disposeEntryRestoreTransactionForExitRef.current();');
        expect(resetExitRefsSource).toContain('entryRestoreOwner.resetForSession({ sessionId: props.sessionId })');
        expect(resetExitRefsSource).not.toContain('entryRestoreTransactionRef.current = null');
        expect(unmountCleanupSource).toContain('disposeEntryRestoreTransactionForExitRef.current();');
        expect(unmountCleanupSource.indexOf('disposeEntryRestoreTransactionForExitRef.current();')).toBeLessThan(
            unmountCleanupSource.indexOf('clearEntryRestoreDeadlineTimeout();'),
        );

        expect(ENTRY_RESTORE_CLOSE_EFFECTS).toContain('slice-anchor');
        expect(ENTRY_RESTORE_CLOSE_EFFECTS).toContain('reveal-entry-slice-window');
        expect(ENTRY_RESTORE_CLOSE_EFFECTS).not.toContain('correctorAppliedDiffTotalPx');
    });

    it('delegates entry-restore transaction and write-context ownership to the entry restore owner', () => {
        expect(ENTRY_RESTORE_OWNER).not.toEqual('');
        expect(ENTRY_RESTORE_OWNER).toContain('createEntryRestoreOwner');
        expect(ENTRY_RESTORE_OWNER).toContain('EntryRestoreOwnerEffect');

        expect(CHATLIST).toContain('createEntryRestoreOwner');
        expect(CHATLIST).toContain('entryRestoreOwnerRef');
        expect(CHATLIST).toContain('applyEntryRestoreOwnerEffects');

        for (const forbiddenHostOwnership of [
            'entryRestoreTransactionRef',
            'entryRestoreWriteContextRef',
            'createEntryRestoreTransaction',
            'resolveEntryRestoreCloseEffects',
            'resolveEntryRestoreDisposeEffects',
            'resolveEntryRestoreTarget',
            'nativeEntryRestoreObservationMatches',
            'currentWriteContext',
            'EntryRestoreWriteContext',
        ]) {
            expect(CHATLIST).not.toContain(forbiddenHostOwnership);
        }
    });

    it('routes latch arm session-entry viewport application through the lifecycle selector and applier', () => {
        const armResetSource = CHATLIST.match(
            /const applySessionOpenArmResetPlan = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const latchEffectSource = CHATLIST.match(
            /const applySessionOpenLatchEffects = React\.useCallback\([\s\S]*?applySessionOpenLatchEffectsRef\.current = applySessionOpenLatchEffects;/,
        )?.[0] ?? '';
        const entryViewportApplierSource = CHATLIST.match(
            /const applySessionEntryViewportApplyEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const entryViewportWrapperSource = CHATLIST.match(
            /const applySessionEntryViewportLifecycleEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(armResetSource).not.toEqual('');
        expect(latchEffectSource).not.toEqual('');
        expect(entryViewportApplierSource).not.toEqual('');
        expect(entryViewportWrapperSource).not.toEqual('');
        expect(CHATLIST).toContain('resolveSessionEntryViewportApplyEffects');
        expect(CHATLIST).toContain('type SessionEntryViewportApplyEffect');

        expect(CHATLIST).not.toContain('applyEffectTimeSessionReset');
        expect(latchEffectSource).toContain("case 'apply-arm-reset-plan'");
        expect(latchEffectSource).toContain('applySessionOpenArmResetPlan(effect.plan)');
        expect(latchEffectSource).toContain("case 'apply-dispose-reset-plan'");

        expect(armResetSource).toContain('const entryViewport = sessionEntryViewportRef.current');
        expect(armResetSource).toContain('const entryEffects = entryViewport?.sessionId === sessionId ? entryViewport.effects : []');
        expect(armResetSource).toContain('const entryAnchor = entryViewport?.sessionId === sessionId ? entryViewport.anchor : null');
        expect(armResetSource).toContain('applySessionEntryViewportLifecycleEffects(entryEffects, entryAnchor)');
        expect(armResetSource).not.toContain('let sessionEntryViewportEffect');
        expect(armResetSource).not.toContain("effect.type === 'session-entry-viewport'");

        expect(entryViewportWrapperSource).toContain('resolveSessionEntryViewportApplyEffects({');
        expect(entryViewportWrapperSource).toContain('effects');
        expect(entryViewportWrapperSource).toContain('sessionId: props.sessionId');
        expect(entryViewportWrapperSource).toContain('applySessionEntryViewportApplyEffects(');
        expect(entryViewportWrapperSource).toContain('entryAnchor');

        for (const statement of [
            'wantsPinnedRef.current = effect.isPinned',
            'isPinnedRef.current = effect.isPinned',
            'setScrollPin({',
            'jumpToBottomDistanceFromBottomRef.current = effect.jumpButtonDistanceFromLiveTailPx',
            'setJumpToBottomDistanceFromBottom(effect.jumpButtonDistanceFromLiveTailPx)',
            'if (effect.shouldEmitViewportChange)',
            'emitViewportChange({',
            'anchor: effect.shouldUseEntryAnchor ? entryAnchor : null',
        ]) {
            expect(entryViewportApplierSource).toContain(statement);
        }
        expect(entryViewportApplierSource).not.toContain("effect.type === 'session-entry-viewport'");
        expect(armResetSource).not.toContain("effect.type === 'session-entry-viewport'");

        expect(SESSION_ENTRY_VIEWPORT)
            .toContain('resolveSessionEntryViewportApplyEffects');
    });

    it('routes native away-gesture live-tail bail through the lifecycle owner before follow intent', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);

        expect(onScrollSource).toContain('scrollObservationHost.observeScroll({');
        expect(onScrollSource).toContain('hasOpenTrustedAwayGesture: nativeAwayGestureStillOpen');
        expect(onScrollSource).toContain('nativeListDragActive: nativeListDragActiveRef.current');
        expect(onScrollSource).not.toContain('resolveNativeScrollAwayGestureLiveTailBailDecision({');
        expect(onScrollSource).not.toContain('resolveNativeScrollAwayGestureLiveTailBailEffects({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollAwayGestureLiveTailBailDecision({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollAwayGestureLiveTailBailEffects({');
        expect(SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollAwayGestureLiveTailBailDecision({')).toBeLessThan(
            SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollFollowIntent({'),
        );
        expect(NATIVE_SCROLL_AWAY_GESTURE_LIVE_TAIL_BAIL).toContain('resolveNativeScrollAwayGestureLiveTailBailDecision');
        expect(NATIVE_SCROLL_AWAY_GESTURE_LIVE_TAIL_BAIL).toContain('resolveNativeScrollAwayGestureLiveTailBailEffects');
    });

    it('consumes native returned release effects before the generic observed-state fallback', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);

        expect(onScrollSource).toContain('const scrollObservationPlan = Platform.OS === \'web\'');
        expect(onScrollSource).toContain('applyScrollObservationHostPlan(scrollObservationPlan');
        expect(onScrollSource).not.toContain('applyNativeScrollReturnOrReleaseLifecycleEffects({');
        expect(SCROLL_OBSERVATION_HOST.indexOf('resolveNativeSettledReturnToLiveTailApplyEffects({')).toBeLessThan(
            SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({'),
        );
        expect(SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({')).toBeLessThan(
            SCROLL_OBSERVATION_HOST.indexOf('resolveNativeObservedViewportStateGenericLifecycleEffects({'),
        );
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('const settledReturnEffects = plan.nativeSettledReturnEffects');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('callbacks.applyNativeAcceptedViewportPaintEffects(plan.acceptedViewportPaintEffects)');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('callbacks.applyNativeSettledReturnToLiveTailDrainEffects(settledReturnEffects.drainEffects)');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('callbacks.applyGenericScrollObservationViewportStateEffects(plan.genericEffects');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('callbacks.applyNativeAcceptedViewportPaintEffects(plan.acceptedViewportPaintEffects)')).toBeLessThan(
            SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('callbacks.applyNativeSettledReturnToLiveTailDrainEffects(settledReturnEffects.drainEffects)'),
        );
        expect(NATIVE_SCROLL_RELEASE_LIVE_TAIL_GENERIC_EFFECT).toContain('resolveNativeScrollReleaseLiveTailGenericLifecycleEffects');
        expect(GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE).toContain('resolveGenericScrollObservationViewportStateApplyEffects');
        expect(NATIVE_RETURN_TO_LIVE_TAIL).toContain('resolveNativeSettledReturnToLiveTailApplyEffects');
    });

    it('consumes native observed viewport-state effects through the generic applier before the generic observed-state fallback', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);

        expect(onScrollSource).toContain('scrollObservationHost.observeScroll({');
        expect(onScrollSource).not.toContain('applyNativeObservedViewportStateLifecycleEffects({');
        expect(SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({')).toBeLessThan(
            SCROLL_OBSERVATION_HOST.indexOf('resolveNativeObservedViewportStateGenericLifecycleEffects({'),
        );
        expect(SCROLL_OBSERVATION_HOST.indexOf('resolveNativeObservedViewportStateGenericLifecycleEffects({')).toBeLessThan(
            SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollReadOnlyVisibleBottomDecision({'),
        );
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain('callbacks.applyGenericScrollObservationViewportStateEffects(plan.genericEffects');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).not.toContain('resolveNativeObservedViewportStateGenericLifecycleEffects({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollAcceptedViewportPaintObservationEffects({');
        expect(NATIVE_OBSERVED_VIEWPORT_STATE_GENERIC_EFFECT).toContain('resolveNativeObservedViewportStateGenericLifecycleEffects');
        expect(GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE).toContain('resolveGenericScrollObservationViewportStateApplyEffects');
    });

    it('consumes native read-only visible-bottom observations through the lifecycle owner before passive drift', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);
        const genericReadOnlyStateApplierSource = CHATLIST.match(
            /const applyGenericScrollObservationReadOnlyVisibleBottomStateEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const genericReadOnlyApplierSource = CHATLIST.match(
            /const applyGenericScrollObservationReadOnlyVisibleBottomEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(onScrollSource).toContain('applyScrollObservationHostPlan(scrollObservationPlan');
        expect(onScrollSource).not.toContain('applyNativeScrollReadOnlyVisibleBottomObservation({');
        expect(SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollReadOnlyVisibleBottomDecision({')).toBeLessThan(
            SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollPassiveDriftBailDecision({'),
        );
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollReadOnlyVisibleBottomGenericEffects(');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain(
            'callbacks.applyGenericScrollObservationReadOnlyVisibleBottomEffects(plan.genericEffects)',
        );
        expect(genericReadOnlyApplierSource).toContain('resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects({');
        expect(genericReadOnlyStateApplierSource).not.toContain('emitViewportChange(');
        expect(genericReadOnlyStateApplierSource).not.toContain('scheduleViewportAnchorCapture(');
        expect(genericReadOnlyStateApplierSource).not.toContain('drainDeferredNewerMessages(');
        expect(genericReadOnlyStateApplierSource).not.toContain('executeViewportCommand(');
        expect(NATIVE_SCROLL_READ_ONLY_VISIBLE_BOTTOM).toContain('resolveNativeScrollReadOnlyVisibleBottomDecision');
        expect(NATIVE_SCROLL_READ_ONLY_VISIBLE_BOTTOM).toContain('resolveNativeScrollReadOnlyVisibleBottomGenericEffects');
        expect(GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE).toContain('resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects');
    });

    it('runs the native mount-settle passive-drift repin preflight after read-only bottom and before passive drift', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);
        const repinApplierSource = CHATLIST.match(
            /const applyNativeMountSettlePassiveDriftRepinObservation = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const repinEffectApplierSource = CHATLIST.match(
            /const applySessionScopedMeasuredNativeAutomaticLiveTailPinEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        const planCreationIndex = onScrollSource.indexOf('const scrollObservationPlan = Platform.OS === \'web\'');
        const repinApplierIndex = onScrollSource.indexOf('applyNativeMountSettlePassiveDriftRepinObservation({');
        const planApplierIndex = onScrollSource.indexOf('applyScrollObservationHostPlan(scrollObservationPlan');

        expect(planCreationIndex).toBeGreaterThanOrEqual(0);
        expect(planApplierIndex).toBeGreaterThan(planCreationIndex);
        expect(repinApplierIndex).toBeGreaterThan(planApplierIndex);
        expect(onScrollSource).toContain('continueAfterEarlyScrollObservation');
        expect(onScrollSource).toContain('shouldApplyNativeMountSettlePassiveDriftRepinObservation');
        expect(onScrollSource).not.toContain('scrollObservationPlan.steps');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain("step.type === 'native-passive-drift-bail'");
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain("step.type === 'generic-fallback'");
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('continueAfterEarlyScrollObservation')).toBeLessThan(
            SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf('callbacks.commitViewportLifecycleState(plan.state)'),
        );
        expect(repinApplierSource).toContain('resolveNativeMountSettlePassiveDriftRepinPreflightDecision({');
        expect(repinApplierSource).toContain('readCurrentNativeDistanceFromBottom()');
        expect(repinApplierSource).toContain('resolveNativeMountSettlePassiveDriftRepinDistanceDecision({');
        expect(repinApplierSource).toContain('resolveNativeMountSettlePassiveDriftRepinEffects({');
        expect(repinEffectApplierSource).toContain('requestMeasuredNativeAutomaticLiveTailPin(effect.reason)');
        expect(repinEffectApplierSource).not.toContain('pinToBottomRespectingNativeMountSettle(effect.reason)');
        expect(CHATLIST).toContain('resolveContentGrowthLiveTailCommandApplyEffect({');
        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).toContain('resolveNativeMountSettlePassiveDriftRepinPreflightDecision');
        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).toContain('resolveNativeMountSettlePassiveDriftRepinDistanceDecision');
        expect(NATIVE_BOTTOM_FOLLOW_OBSERVATION_POLICY).toContain('resolveNativeMountSettlePassiveDriftRepinEffects');
        expect(CONTENT_GROWTH_LIVE_TAIL_COMMAND).toContain('resolveContentGrowthLiveTailCommandApplyEffect');
    });

    it('delegates native passive-drift bail to the lifecycle suppression owner before the generic observed-state fallback', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);
        const genericSuppressionApplierSource = CHATLIST.match(
            /const applyGenericScrollObservationSuppressionApplyEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const genericSuppressionWrapperSource = CHATLIST.match(
            /const applyGenericScrollObservationSuppressionEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        const repinApplierIndex = onScrollSource.indexOf('applyNativeMountSettlePassiveDriftRepinObservation({');
        const planApplierIndex = onScrollSource.indexOf('applyScrollObservationHostPlan(scrollObservationPlan');

        expect(repinApplierIndex).toBeGreaterThanOrEqual(0);
        expect(repinApplierIndex).toBeGreaterThan(planApplierIndex);
        expect(onScrollSource).not.toContain('applyNativeScrollPassiveDriftBailObservation({');
        expect(SCROLL_OBSERVATION_HOST.indexOf('resolveNativeScrollPassiveDriftBailDecision({')).toBeLessThan(
            SCROLL_OBSERVATION_HOST.indexOf('resolveGenericScrollObservationViewportStateEffects({'),
        );
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveNativeScrollPassiveDriftBailGenericEffects({');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain(
            'callbacks.applyGenericScrollObservationSuppressionEffects(plan.genericEffects)',
        );
        expect(genericSuppressionWrapperSource).toContain('resolveGenericScrollObservationSuppressionApplyEffects({');
        expect(genericSuppressionApplierSource).not.toContain('emitViewportChange(');
        expect(genericSuppressionApplierSource).not.toContain('scheduleViewportAnchorCapture(');
        expect(genericSuppressionApplierSource).not.toContain('setScrollPin(');
        expect(genericSuppressionApplierSource).not.toContain('drainDeferredNewerMessages(');
        expect(genericSuppressionApplierSource).not.toContain('executeViewportCommand(');
        expect(NATIVE_SCROLL_PASSIVE_DRIFT_BAIL).toContain('resolveNativeScrollPassiveDriftBailDecision');
        expect(NATIVE_SCROLL_PASSIVE_DRIFT_BAIL).toContain('resolveNativeScrollPassiveDriftBailGenericEffects');
        expect(GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE).toContain('resolveGenericScrollObservationSuppressionApplyEffects');
    });

    it('delegates generic anchor-capture cancellation to the lifecycle effect owner after suppression', () => {
        const genericCancellationApplierSource = CHATLIST.match(
            /const applyGenericScrollObservationAnchorCaptureCancellationApplyEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';
        const genericCancellationWrapperSource = CHATLIST.match(
            /const applyGenericScrollObservationAnchorCaptureCancellationEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        expect(SCROLL_OBSERVATION_HOST).toContain('resolveGenericScrollObservationAnchorCaptureCancellationEffects({');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf(
            'callbacks.applyGenericScrollObservationSuppressionEffects(plan.genericEffects)',
        )).toBeLessThan(SCROLL_OBSERVATION_HOST_PLAN_APPLIER.indexOf(
            'callbacks.applyGenericScrollObservationAnchorCaptureCancellationEffects(plan.genericEffects)',
        ));
        expect(genericCancellationWrapperSource).toContain('resolveGenericScrollObservationAnchorCaptureCancellationApplyEffects({');
        expect(genericCancellationApplierSource).toContain('invalidateViewportAnchorCapture()');
        expect(genericCancellationApplierSource).not.toContain('emitViewportChange(');
        expect(genericCancellationApplierSource).not.toContain('scheduleViewportAnchorCapture(');
        expect(genericCancellationApplierSource).not.toContain('setScrollPin(');
        expect(genericCancellationApplierSource).not.toContain('drainDeferredNewerMessages(');
        expect(GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE).toContain(
            'resolveGenericScrollObservationAnchorCaptureCancellationApplyEffects',
        );
    });

    it('delegates the active native observed-state fallback to the generic viewport-state effect owner', () => {
        const onScrollStart = CHATLIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>)');
        const onScrollEnd = CHATLIST.indexOf('onMomentumScrollBegin', onScrollStart);
        expect(onScrollStart).toBeGreaterThanOrEqual(0);
        expect(onScrollEnd).toBeGreaterThan(onScrollStart);
        const onScrollSource = CHATLIST.slice(onScrollStart, onScrollEnd);
        const genericViewportStateApplierSource = CHATLIST.match(
            /const applyGenericScrollObservationViewportStateApplyEffects = React\.useCallback\([\s\S]*?\n\s*\}, \[[^\]]+\]\);/,
        )?.[0] ?? '';

        const repinApplierIndex = onScrollSource.indexOf('applyNativeMountSettlePassiveDriftRepinObservation({');
        const planApplierIndex = onScrollSource.indexOf('applyScrollObservationHostPlan(scrollObservationPlan');
        const postPlanApplierSlice = onScrollSource.slice(planApplierIndex);

        expect(repinApplierIndex).toBeGreaterThan(planApplierIndex);
        expect(onScrollSource).not.toContain('applyGenericScrollObservationViewportStateFallback({');
        expect(SCROLL_OBSERVATION_HOST).toContain('resolveGenericScrollObservationViewportStateEffects({');
        expect(SCROLL_OBSERVATION_HOST).toContain('followIntentIsPinned: followIntent.isPinned');
        expect(SCROLL_OBSERVATION_HOST).toContain('followIntentNextDistanceFromLiveTailPx: followIntent.nextDistanceFromBottom');
        expect(SCROLL_OBSERVATION_HOST).toContain('followIntentNextScrollOffsetPx: followIntent.nextScrollOffset');
        expect(SCROLL_OBSERVATION_HOST).toContain('followIntentWantsPinned: followIntent.wantsPinned');
        expect(SCROLL_OBSERVATION_HOST).toContain('viewportDistanceFromLiveTailPx: input.distanceFromLiveTailPx');
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain(
            'callbacks.applyNativeAcceptedViewportPaintEffects(plan.acceptedViewportPaintEffects)',
        );
        expect(SCROLL_OBSERVATION_HOST_PLAN_APPLIER).toContain(
            'callbacks.applyGenericScrollObservationViewportStateEffects(plan.genericEffects',
        );
        expect(postPlanApplierSlice).not.toContain(
            'lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom',
        );
        expect(postPlanApplierSlice).not.toContain(
            'lastScrollOffsetForIntentRef.current = followIntent.nextScrollOffset',
        );
        expect(postPlanApplierSlice).not.toContain('const viewportState = {');
        expect(postPlanApplierSlice).not.toContain('emitViewportChange(viewportState)');
        expect(postPlanApplierSlice).not.toContain('scheduleViewportAnchorCapture(viewportState');
        expect(postPlanApplierSlice).not.toContain('setScrollPin((prev) =>');
        expect(postPlanApplierSlice).not.toContain('drainDeferredNewerMessages({');
        expect(genericViewportStateApplierSource).toContain('lastPinOffsetForIntentRef.current = state.lastDistanceFromLiveTailPx');
        expect(genericViewportStateApplierSource).toContain('emitViewportChange(state.viewportState)');
        expect(genericViewportStateApplierSource).toContain('scheduleViewportAnchorCapture(state.anchorCapture.viewportState');
        expect(genericViewportStateApplierSource).toContain('drainDeferredNewerMessages({');
        expect(genericViewportStateApplierSource).toContain('recordAcceptedViewportPaintObservation');
        expect(GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE).toContain('resolveGenericScrollObservationViewportStateEffects');
        expect(GENERIC_SCROLL_OBSERVATION_VIEWPORT_STATE).toContain('resolveGenericScrollObservationViewportStateApplyEffects');
    });

    it('routes explicit return and takeover state through lifecycle helpers instead of the host mode resolver', () => {
        const jumpToBottomSource = CHATLIST.match(
            /const jumpToBottom = React\.useCallback\([\s\S]*?\n\s*\}, \[[\s\S]*?\]\);/,
        )?.[0] ?? '';
        const followBottomIntentSource = CHATLIST.slice(
            CHATLIST.indexOf('const followBottomIntentKey = props.followBottomIntentKey ?? null;'),
            CHATLIST.indexOf('const resolveAutoPinWaitMs', CHATLIST.indexOf('const followBottomIntentKey = props.followBottomIntentKey ?? null;')),
        );
        expect(CHATLIST).not.toContain('resolveTranscriptBottomFollowMode');
        expect(CHATLIST).not.toContain('commitBottomFollowModeEvent');
        expect(CHATLIST).not.toContain("from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent'");
        expect(CHATLIST).not.toContain('resolveTranscriptBottomFollowIntent({');

        expect(CHATLIST).toContain('resolveExplicitReturnToLiveTailViewportEffects');
        expect(CHATLIST).toContain('resolveExplicitJumpTakeoverApplyEffects');
        expect(CHATLIST).toContain('resolveFollowBottomIntentTakeoverApplyEffects');
        expect(CHATLIST).toContain('const commitExplicitReturnToLiveTailState = React.useCallback');
        expect(CHATLIST).toContain('const applyExplicitJumpTakeoverLifecycleEffects = React.useCallback');
        expect(CHATLIST).toContain('const applyFollowBottomIntentTakeoverLifecycleEffects = React.useCallback');

        expect(jumpToBottomSource).toContain('dispatchViewportLifecycleEvent({');
        expect(jumpToBottomSource).toContain("type: 'explicit-jump-takeover'");
        expect(jumpToBottomSource.indexOf("type: 'explicit-jump-takeover'")).toBeLessThan(
            jumpToBottomSource.indexOf('executeViewportCommandWithAnimation('),
        );
        expect(jumpToBottomSource).toContain("commitExplicitReturnToLiveTailState('jump-to-bottom')");
        expect(jumpToBottomSource).not.toContain("commitBottomFollowModeEvent({ type: 'jump-to-bottom' })");

        expect(followBottomIntentSource).toContain("commitExplicitReturnToLiveTailState('follow-bottom-intent')");
        expect(followBottomIntentSource).toContain('dispatchViewportLifecycleEvent({');
        expect(followBottomIntentSource).toContain("type: 'follow-bottom-intent-takeover'");
        expect(followBottomIntentSource).toContain('applyFollowBottomIntentTakeoverLifecycleEffects(transition.effects)');
        expect(followBottomIntentSource).not.toContain("commitBottomFollowModeEvent({ type: 'follow-bottom-intent' })");
    });

    it('routes web prepend restore-window ownership through the web prepend owner', () => {
        expect(CHATLIST).toContain("from '@/components/sessions/transcript/viewport/prepend/webPrependOwner'");
        expect(CHATLIST).toContain('createWebPrependOwner');
        expect(CHATLIST).toContain('webPrependOwner.clear({');
        expect(CHATLIST).toContain('webPrependOwner.beforeLoad({');
        expect(CHATLIST).toContain('webPrependOwner.afterLoad({');
        expect(CHATLIST).toContain('webPrependOwner.acceptRestoreResult({');
        expect(CHATLIST).toContain('webPrependOwner.retryPending({');
        expect(CHATLIST).not.toContain('pendingWebPrependAnchorRef');
        expect(CHATLIST).not.toContain('inFlightWebPrependAnchorRef');
        expect(CHATLIST).not.toContain('pendingWebPrependIndexRecoveryRef');
        expect(CHATLIST).not.toContain('scheduledWebPrependIndexRecoveryRef');
        expect(CHATLIST).not.toContain('webPrependRestoreWindowExpiryTimeoutRef');
        expect(CHATLIST).not.toContain('resolvePendingWebPrependRecoveryIndex');
        expect(CHATLIST).not.toContain('recordWebPrependRestoreOutcome');
    });

    it('clears web prepend owner state unconditionally on session reset', () => {
        const resetStart = CHATLIST.indexOf('const applySessionOpenArmResetPlan = React.useCallback(');
        expect(resetStart).toBeGreaterThanOrEqual(0);
        const resetEnd = CHATLIST.indexOf('const applySessionOpenDisposeResetPlan = React.useCallback(', resetStart);
        expect(resetEnd).toBeGreaterThan(resetStart);
        const resetSource = CHATLIST.slice(resetStart, resetEnd);

        const clearStart = resetSource.indexOf('webPrependOwner.clear({');
        expect(clearStart).toBeGreaterThanOrEqual(0);
        const clearEnd = resetSource.indexOf('}));', clearStart);
        expect(clearEnd).toBeGreaterThan(clearStart);
        const clearSource = resetSource.slice(clearStart, clearEnd);

        expect(clearSource).toContain("outcome: 'abandoned-identity'");
        expect(clearSource).not.toContain('sessionId');
    });

    it('cancels every web prepend timer family on unmount', () => {
        const cleanupStart = CHATLIST.indexOf('// Never leak web prepend restore-window timers across unmount.');
        expect(cleanupStart).toBeGreaterThanOrEqual(0);
        const cleanupEnd = CHATLIST.indexOf('React.useLayoutEffect(() => {', cleanupStart);
        expect(cleanupEnd).toBeGreaterThan(cleanupStart);
        const cleanupSource = CHATLIST.slice(cleanupStart, cleanupEnd);

        expect(cleanupSource).toContain('cancelWebPrependRestoreWindowExpiry();');
        expect(cleanupSource).toContain('cancelScheduledWebPrependIndexRecovery();');
    });

    it('keeps native blank-window telemetry independent from native prepend owner state', () => {
        expect(CHATLIST).toContain('recordNativeVisibleWindowTelemetry');
        expect(CHATLIST).toContain("from '@/components/sessions/transcript/viewport/prepend/nativePrependOwner'");
        expect(CHATLIST).toContain('nativePrependOwner.telemetryState(props.sessionId)');
        expect(CHATLIST).not.toContain('recordNativeVisibleWindowTelemetry(nativePrependOwner');
    });
});
