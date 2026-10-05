import type { ScmComparison, ScmComparisonFile, ScmDiffSummaryAnalysisCoverage, ScmDiffSummaryWalkthrough } from '@happier-dev/protocol';

/**
 * Dev-only: the Walkthrough lab's illustration (the "Fix settings modal remount" session) as a captured
 * comparison and a walkthrough output, so the real reading view can be drawn without a reachable Home.
 * Sample names and counts are illustration, never product logic.
 */
type FileSpec = Readonly<{ path: string; changeKind?: string; lockfile?: boolean; hunks: readonly string[]; header?: string }>;

const MODAL_IMPORT = `@@ -1,6 +1,7 @@
 import * as React from 'react';
 import { useWindowDimensions } from 'react-native';
 import { Modal } from '@/components/ui/modal/Modal';
 import { SettingsBody } from './SettingsBody';
+import { useSettingsRouteKey } from './useSettingsRouteKey';
 import type { SettingsRoute } from './settingsRoutes';
 `;
const MODAL_KEY = `@@ -18,4 +19,5 @@ export function SettingsModal({ route, onClose }: Props) {
 export function SettingsModal({ route, onClose }: Props) {
     const { width } = useWindowDimensions();
-    const key = \`\${route.path}:\${width}\`;
+    // Keyed by route only: a resize must not remount the modal.
+    const key = useSettingsRouteKey(route);
     return (`;
const MODAL_COMPACT = `@@ -22,5 +24,5 @@ export function SettingsModal({ route, onClose }: Props) {
-        <Modal key={key} onDismiss={onClose}>
+        <Modal key={key} compact={width < 600} onDismiss={onClose}>
             <SettingsBody route={route} />
         </Modal>
     );
 }`;
const ROUTE_KEY = `@@ -0,0 +1,21 @@
+import * as React from 'react';
+import type { SettingsRoute } from './settingsRoutes';
+
+/**
+ * A stable key for the settings modal. It changes when the route changes,
+ * never when the window resizes, so the modal keeps its draft and scroll.
+ */
+export function useSettingsRouteKey(route: SettingsRoute): string {
+    return React.useMemo(() => {
+        switch (route.kind) {
+            case 'section':
+                return \`section:\${route.section}\`;
+            case 'search':
+                return 'search';
+            default:
+                return 'root';
+        }
+    }, [route]);
+}
+
+export type SettingsRouteKey = ReturnType<typeof useSettingsRouteKey>;`;
const ROUTES = `@@ -4,3 +4,4 @@ import type { SettingsSectionId } from './sections';
 export type SettingsRoute =
-    | { path: string; section?: SettingsSectionId }
-    | { path: string; query: string };
+    | { kind: 'root'; path: string }
+    | { kind: 'section'; path: string; section: SettingsSectionId }
+    | { kind: 'search'; path: string; query: string };`;
const SHEET = `@@ -9,5 +9,4 @@ export function SettingsSheet({ route, onClose }: Props) {
     const insets = useSafeAreaInsets();
-    const { width, height } = useWindowDimensions();
-    const key = \`\${route.path}:\${width}x\${height}\`;
+    const key = useSettingsRouteKey(route);
     return (
         <Sheet key={key} topInset={insets.top} onDismiss={onClose}>`;
const SCREEN_OPEN = `@@ -11,3 +11,3 @@ export default function SettingsScreen() {
     const route = useSettingsRoute();
-    const [open, setOpen] = React.useState(true);
+    const [open, setOpen] = React.useState(() => route.kind !== 'root');
     const close = React.useCallback(() => setOpen(false), []);`;
const SCREEN_KEY = `@@ -16,2 +16,2 @@ export default function SettingsScreen() {
     if (!open) return null;
-    return <SettingsModal key={route.path} route={route} onClose={close} />;
+    return <SettingsModal route={route} onClose={close} />;`;
const TEST_CASE = `@@ -58,3 +58,14 @@ describe('SettingsModal', () => {
         expect(onClose).toHaveBeenCalledTimes(1);
    });
 
+    it('keeps the draft when the window resizes', async () => {
+        const screen = renderSettingsModal({ route: sectionRoute('account') });
+        await screen.typeInto('display-name', 'Leeroy B.');
+
+        setWindowWidth(1280);
+        setWindowWidth(760);
+
+        expect(screen.getInput('display-name')).toHaveValue('Leeroy B.');
+        expect(screen.mountCount('SettingsModal')).toBe(1);
+    });
+`;
const TEST_IMPORT = `@@ -3,2 +3,2 @@
 import { renderSettingsModal, sectionRoute } from './settingsTestkit';
-import { act } from '@testing-library/react-native';
+import { setWindowWidth } from '@/dev/testkit/window';`;
const LAYOUT_CONST = `@@ -1,1 +1,4 @@
+/** Below this width the modal uses its compact, single-column layout. */
+export const COMPACT_MODAL_WIDTH = 600;
+
 export function useModalLayout() {`;
const LAYOUT_USE = `@@ -3,3 +6,3 @@ export function useModalLayout() {
     const { width } = useWindowDimensions();
-    return { compact: width < 600 };
+    return { compact: width < COMPACT_MODAL_WIDTH };
 }`;
const COPY = `@@ -412,1 +412,3 @@ export const en = {
     settingsTitle: 'Settings',
+    settingsCompactHint: 'Showing the compact layout',
+    settingsCompactExit: 'Show the full layout',`;
const LOCK = `@@ -1203,4 +1203,4 @@
-"@happier/modal@0.4.1":
-  version "0.4.1"
+"@happier/modal@0.4.2":
+  version "0.4.2"
   dependencies:
     react-native-safe-area-context "^5.0.0"`;

const FILES: readonly FileSpec[] = [
    { path: 'apps/ui/sources/components/settings/SettingsModal.tsx', hunks: [MODAL_IMPORT, MODAL_KEY, MODAL_COMPACT] },
    { path: 'apps/ui/sources/components/settings/useSettingsRouteKey.ts', changeKind: 'added', hunks: [ROUTE_KEY] },
    { path: 'apps/ui/sources/components/settings/settingsRoutes.ts', hunks: [ROUTES] },
    { path: 'apps/ui/sources/components/settings/SettingsSheet.tsx', hunks: [SHEET] },
    { path: 'apps/ui/sources/app/(app)/settings.tsx', hunks: [SCREEN_OPEN, SCREEN_KEY] },
    { path: 'apps/ui/sources/components/settings/SettingsModal.test.tsx', hunks: [TEST_IMPORT, TEST_CASE] },
    { path: 'apps/ui/sources/components/ui/modal/useModalLayout.ts', hunks: [LAYOUT_CONST, LAYOUT_USE] },
    { path: 'apps/ui/sources/text/en.ts', hunks: [COPY] },
    { path: 'yarn.lock', lockfile: true, hunks: [LOCK] },
];

function rangeOf(header: string) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    return {
        before: { startLine: Number(match?.[1] ?? 0), lineCount: Number(match?.[2] ?? 1) },
        after: { startLine: Number(match?.[3] ?? 0), lineCount: Number(match?.[4] ?? 1) },
    };
}

let alias = 0;
function fileOf(spec: FileSpec): ScmComparisonFile {
    const changeKind = spec.changeKind ?? 'modified';
    const header = [
        `diff --git a/${spec.path} b/${spec.path}`,
        changeKind === 'added' ? '--- /dev/null' : `--- a/${spec.path}`,
        `+++ b/${spec.path}`,
    ].join('\n');
    return {
        path: spec.path,
        changeKind,
        binary: false,
        generated: false,
        lockfile: spec.lockfile === true,
        evidence: { state: 'available', unifiedDiff: [header, ...spec.hunks].join('\n') },
        occurrences: spec.hunks.map((hunk, position) => ({
            id: `${spec.path}#${position}`,
            alias: `c${++alias}`,
            path: spec.path,
            ...rangeOf(hunk),
            position,
        })),
    };
}

export const SPECIMEN_COMPARISON: ScmComparison = {
    id: 'specimen-comparison',
    source: { kind: 'session', sessionId: 'specimen-session' },
    repository: { rootPath: '/repo' },
    endpoints: { before: 'b0', after: 'a0' },
    inventory: { state: 'complete', reasons: [], files: FILES.map(fileOf) },
};

const ref = (path: string, position: number) => `${path}#${position}`;
const MODAL = 'apps/ui/sources/components/settings/SettingsModal.tsx';
const KEY = 'apps/ui/sources/components/settings/useSettingsRouteKey.ts';
const ROUTES_PATH = 'apps/ui/sources/components/settings/settingsRoutes.ts';
const SHEET_PATH = 'apps/ui/sources/components/settings/SettingsSheet.tsx';
const SCREEN = 'apps/ui/sources/app/(app)/settings.tsx';
const TEST = 'apps/ui/sources/components/settings/SettingsModal.test.tsx';
const LAYOUT = 'apps/ui/sources/components/ui/modal/useModalLayout.ts';

export const SPECIMEN_WALKTHROUGH: ScmDiffSummaryWalkthrough = {
    title: 'Keep the settings modal mounted across resizes',
    intro: 'The modal’s key mixed the route with the window width, so every resize remounted it and threw away the draft and the scroll position. Both the modal and the phone sheet are now keyed by route alone, the compact layout became a prop, and a new test resizes twice to prove the draft survives.',
    stops: [
        {
            id: 'why', title: 'Why the modal remounted', importance: 'high', changeRefs: [ref(MODAL, 1)],
            explanationMarkdown: 'React keys the modal with `key`. It combined the route path with the window width, so every resize produced a new key and React threw the modal away, along with the draft, scroll position and focus. The key now comes from the route alone.',
        },
        {
            id: 'key', title: 'One key per route', importance: 'high', changeRefs: [ref(KEY, 0), ref(ROUTES_PATH, 0), ref(MODAL, 0)],
            explanationMarkdown: 'A small hook turns a route into a key that only changes when the destination does. It depends on the new `kind` field on `SettingsRoute`, so a search and a section can never share a key.',
        },
        {
            id: 'sheet', title: 'The phone sheet uses the same key', importance: 'high', changeRefs: [ref(SHEET_PATH, 0)],
            explanationMarkdown: 'The phone sheet had its own copy of the width-and-height key, so rotating a phone remounted it the same way. It now calls the same hook.',
        },
        {
            id: 'compact', title: 'Compact layout without a remount', importance: 'low', changeRefs: [ref(MODAL, 2), ref(LAYOUT, 0), ref(LAYOUT, 1), ref(SCREEN, 0), ref(SCREEN, 1)],
            explanationMarkdown: 'Narrow windows still get the compact layout, now as a prop on the same modal instead of a new one. The 600 breakpoint moved into `useModalLayout`, and the screen stopped passing its own key.',
        },
        {
            id: 'test', title: 'Proving it: resize twice, keep the draft', importance: 'high', changeRefs: [ref(TEST, 1), ref(TEST, 0)],
            explanationMarkdown: 'The new test types a display name, resizes the window to 1280 and then 760, and checks the draft is still there and the modal mounted exactly once.',
        },
    ],
    otherChangeRefs: [ref('apps/ui/sources/text/en.ts', 0), ref('yarn.lock', 0)],
};

const ALL_REFS = SPECIMEN_COMPARISON.inventory.files.flatMap((file) => file.occurrences.map((occurrence) => occurrence.id));
export const SPECIMEN_ANALYSIS_COMPLETE: ScmDiffSummaryAnalysisCoverage = { suppliedChangeRefs: ALL_REFS, analysedChangeRefs: ALL_REFS, remainingChangeRefs: [] };
export const SPECIMEN_ANALYSIS_EARLY: ScmDiffSummaryAnalysisCoverage = { suppliedChangeRefs: ALL_REFS, analysedChangeRefs: ALL_REFS.slice(0, 4), remainingChangeRefs: ALL_REFS.slice(4) };
export const SPECIMEN_ANALYSIS_MOST: ScmDiffSummaryAnalysisCoverage = { suppliedChangeRefs: ALL_REFS, analysedChangeRefs: ALL_REFS.slice(0, 11), remainingChangeRefs: ALL_REFS.slice(11) };
export const SPECIMEN_ANALYSIS_STOPPED: ScmDiffSummaryAnalysisCoverage = { suppliedChangeRefs: ALL_REFS, analysedChangeRefs: ALL_REFS.slice(0, 9), remainingChangeRefs: ALL_REFS.slice(9) };

/** Explicit marks on the first `count` stops (the person's, never inferred). */
export function specimenReviewedRefs(count: number): string[] {
    return SPECIMEN_WALKTHROUGH.stops.slice(0, count).flatMap((stop) => stop.changeRefs);
}

/** The merged-stops refinement of lab WT3-D2: stops 2 and 3 became one, the person's renamed title kept. */
export const SPECIMEN_WALKTHROUGH_MERGED: ScmDiffSummaryWalkthrough = {
    ...SPECIMEN_WALKTHROUGH,
    stops: [
        SPECIMEN_WALKTHROUGH.stops[0]!,
        {
            id: 'key', title: 'One key for the modal and the sheet', importance: 'high',
            changeRefs: [...SPECIMEN_WALKTHROUGH.stops[1]!.changeRefs, ...SPECIMEN_WALKTHROUGH.stops[2]!.changeRefs],
            explanationMarkdown: 'A small hook turns a route into a key that only changes when the destination does, and both the modal and the phone sheet now use it. It depends on the new `kind` field on `SettingsRoute`, so a search and a section never share a key.',
        },
        { ...SPECIMEN_WALKTHROUGH.stops[3]!, title: 'Narrow windows, same modal' },
        SPECIMEN_WALKTHROUGH.stops[4]!,
    ],
};
