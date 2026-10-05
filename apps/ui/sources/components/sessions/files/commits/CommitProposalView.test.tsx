import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ScmCommitPlanApplication, ScmComparison, ScmDiffSummaryCommitPlan } from '@happier-dev/protocol';

import { SPECIMEN_COMPARISON } from '@/components/dev/changes/walkthroughSpecimenFixture';

import { buildCommitProposal } from './commitProposal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});
// Overlay and button leaves stand in as host elements; the view's projection, menus' contents and decisions run for real.
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { CommitProposalView } = await import('./CommitProposalView');

const PENDING: ScmComparison = { ...SPECIMEN_COMPARISON, id: 'pending', source: { kind: 'workingTree' } };
const MODAL = 'apps/ui/sources/components/settings/SettingsModal.tsx';
const KEY = 'apps/ui/sources/components/settings/useSettingsRouteKey.ts';
const TEST = 'apps/ui/sources/components/settings/SettingsModal.test.tsx';
const PLAN: ScmDiffSummaryCommitPlan = {
    groups: [
        { id: 'one', message: 'Key by route', rationale: 'The fix.', changeRefs: [`${KEY}#0`, `${MODAL}#0`, `${MODAL}#1`] },
        { id: 'two', message: 'Compact prop', rationale: '', changeRefs: [`${MODAL}#2`] },
        { id: 'three', message: 'Test it', rationale: '', changeRefs: [`${TEST}#0`, `${TEST}#1`] },
    ],
    leftOutChangeRefs: ['yarn.lock#0'],
};

function application(patch: Partial<ScmCommitPlanApplication>): ScmCommitPlanApplication {
    return {
        acceptedRevision: 1,
        acceptance: { comparisonId: 'pending', repositoryRootPath: '/repo', expectedHeadOid: null, expectedRef: 'refs/heads/main', ...PLAN },
        status: 'applying',
        steps: PLAN.groups.map((group) => ({ groupId: group.id, state: 'pending' as const })),
        nextGroupIndex: 0,
        stopAfterCurrent: false,
        ...patch,
    };
}

async function render(app: ScmCommitPlanApplication | null, actions: Record<string, unknown>, plan: ScmDiffSummaryCommitPlan = PLAN) {
    return renderScreen(
        <CommitProposalView proposal={buildCommitProposal({ comparison: PENDING, plan, application: app })} phase="ready"
            branch="main" modelLabel="Opus 5.5" layout="wide" actions={actions} />,
    );
}

type Instance = { children: ReadonlyArray<Instance | string> };
/** The text a rendered subtree reads, in order. */
function textOf(node: Instance | null | undefined): string {
    if (!node) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

function menus(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => (node.type as unknown) === 'DropdownMenu');
}

describe('CommitProposalView (lab WT4-C1/C3/C4)', () => {
    it.each(['wide', 'phone'] as const)('does not offer unverified hook content for Include (%s)', async (layout) => {
        const onIncludeHookChanges = vi.fn();
        const proposal = buildCommitProposal({ comparison: PENDING, plan: PLAN, application: application({
            status: 'paused', reason: 'hook_content_changed', nextGroupIndex: 1,
            steps: [{ groupId: 'one', state: 'published', commitSha: 'a'.repeat(40) },
                { groupId: 'two', state: 'not_published', hookContentChanges: {
                    beforeTreeOid: 'b'.repeat(40), afterTreeOid: 'c'.repeat(40), changes: [{ path: MODAL, kind: 'modified' }],
                } }, { groupId: 'three', state: 'pending' }],
        }) });
        // A supported older reader can succeed but cannot attest the requested immutable tree pair.
        const screen = await renderScreen(<CommitProposalView proposal={proposal} phase="ready" branch="main" modelLabel={null}
            layout={layout} actions={{ onIncludeHookChanges, readHookDiff: async () => ({ success: true, diff: '+unwitnessed' }) }} />);
        const include = screen.findByTestId('commit-plan-include-hook');
        expect(include?.props.disabled).toBe(true);
        (include?.props.onPress as (() => void) | undefined)?.();
        expect(onIncludeHookChanges).not.toHaveBeenCalled();
        expect(screen.findByTestId('commit-hook-evidence-unavailable')).toBeTruthy();
    });

    it.each(['wide', 'phone'] as const)('inspects the exact hook delta, including added files, and replaces it on a second pause (%s)', async (layout) => {
        const before = 'b'.repeat(40);
        const after = 'c'.repeat(40);
        const renewed = 'd'.repeat(40);
        const added = 'src/hook-added.ts';
        const diff = [
            `diff --git a/${MODAL} b/${MODAL}`, `--- a/${MODAL}`, `+++ b/${MODAL}`, '@@ -1 +1 @@', '-selected', '+hook formatted',
            `diff --git a/${added} b/${added}`, 'new file mode 100644', '--- /dev/null', `+++ b/${added}`, '@@ -0,0 +1,2 @@', '+hook line one', '+hook line two', '',
        ].join('\n');
        let releaseRenewed = () => {};
        const renewedRead = new Promise<void>((resolve) => { releaseRenewed = resolve; });
        const readHookDiff = vi.fn(async (trees: { beforeTreeOid: string; afterTreeOid: string }) => {
            if (trees.afterTreeOid === renewed) await renewedRead;
            const currentDiff = trees.afterTreeOid === after ? diff : diff.replaceAll(added, 'src/renewed.ts').replaceAll('hook line', 'renewed line');
            const offset = currentDiff.indexOf('diff --git a/src/');
            return { success: true, ...trees, diff: currentDiff, files: [
                { path: MODAL, changeKind: 'modified' as const, unifiedDiff: currentDiff.slice(0, offset) },
                { path: trees.afterTreeOid === after ? added : 'src/renewed.ts', changeKind: 'added' as const, unifiedDiff: currentDiff.slice(offset) },
            ] };
        });
        const paused = (beforeTreeOid: string, afterTreeOid: string) => buildCommitProposal({ comparison: PENDING, plan: PLAN,
            application: application({ status: 'paused', reason: 'hook_content_changed', nextGroupIndex: 1, steps: [
                { groupId: 'one', state: 'published', commitSha: 'a'.repeat(40) },
                { groupId: 'two', state: 'not_published', hookContentChanges: { beforeTreeOid, afterTreeOid, changes: [
                    { path: MODAL, kind: 'modified' }, { path: afterTreeOid === after ? added : 'src/renewed.ts', kind: 'added' },
                ] } }, { groupId: 'three', state: 'pending' },
            ] }) });
        const props = { phase: 'ready' as const, branch: 'main', modelLabel: null, layout, actions: { readHookDiff, onIncludeHookChanges: vi.fn() } };
        const screen = await renderScreen(<CommitProposalView {...props} proposal={paused(before, after)} />);
        expect(readHookDiff).toHaveBeenCalledWith({ beforeTreeOid: before, afterTreeOid: after });
        const row = screen.findByTestId(`commit-hook-change:${added}`);
        expect(row).toBeTruthy();
        expect(screen.findHostByTestId(`commit-hook-change:${added}`)?.props.accessibilityState?.expanded).toBe(false);
        expect(textOf(row as unknown as Instance)).toContain('+2');
        expect(textOf(screen.findByTestId(`commit-hook-change:${MODAL}`) as unknown as Instance)).toContain('−1');
        await screen.pressByTestIdAsync(`commit-hook-change:${added}`);
        expect(screen.findHostByTestId(`commit-hook-change:${added}`)?.props.accessibilityState?.expanded).toBe(true);
        expect(textOf(screen.findByTestId(`commit-hook-diff:${added}`) as unknown as Instance)).toContain('hook line two');
        await act(async () => screen.tree.update(<CommitProposalView {...props} proposal={paused(after, renewed)} />));
        expect(readHookDiff).toHaveBeenLastCalledWith({ beforeTreeOid: after, afterTreeOid: renewed });
        expect(screen.findByTestId(`commit-hook-change:${added}`)).toBeNull();
        expect(screen.findByTestId('commit-plan-include-hook')?.props.disabled).toBe(true);
        await act(async () => releaseRenewed());
        expect(screen.findByTestId('commit-plan-include-hook')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('commit-hook-change:src/renewed.ts');
        expect(textOf(screen.findByTestId('commit-hook-diff:src/renewed.ts') as unknown as Instance)).toContain('renewed line two');
        expect(screen.findByTestId('commit-group:one')).toBeTruthy();
    });

    it('moves exactly the chosen file part: to another commit, a new commit after its own, or Left out', async () => {
        const onMove = vi.fn();
        const screen = await render(null, { onMove, onCreate: vi.fn() });
        // The first Move menu belongs to the first row of commit 1; its file's part in commit 1 travels together.
        const modalMenu = menus(screen).find((node) => (node.props.items as { category?: string }[])[0]?.category?.includes('SettingsModal.tsx'));
        expect(modalMenu).toBeTruthy();
        const items = modalMenu!.props.items as { id: string; shortcut?: string; checked?: boolean }[];
        expect(items.filter((item) => item.id.startsWith('group:')).map((item) => [item.id, item.shortcut, item.checked]))
            .toEqual([['group:one', '⌥1', true], ['group:two', '⌥2', false], ['group:three', '⌥3', false]]);
        const select = modalMenu!.props.onSelect as (id: string) => void;
        select('group:two');
        select('new:one');
        select('leftOut');
        expect(onMove.mock.calls.map(([change, target]) => [change.changeRefs, target])).toEqual([
            [[`${MODAL}#0`, `${MODAL}#1`], { kind: 'group', groupId: 'two' }],
            [[`${MODAL}#0`, `${MODAL}#1`], { kind: 'newGroupAfter', groupId: 'one' }],
            [[`${MODAL}#0`, `${MODAL}#1`], { kind: 'leftOut' }],
        ]);
    });

    it('pauses editing while a run applies: no menus or message edits, only Stop after this commit', async () => {
        const screen = await render(application({ nextGroupIndex: 1, steps: [
            { groupId: 'one', state: 'published', commitSha: 'a'.repeat(40) }, { groupId: 'two', state: 'writing' }, { groupId: 'three', state: 'pending' },
        ] }), { onMove: vi.fn(), onEditMessage: vi.fn(), onCreate: vi.fn(), onStopAfterCurrent: vi.fn() });
        expect(menus(screen)).toHaveLength(0);
        expect(screen.findByTestId('commit-group-edit:two')).toBeNull();
        expect(screen.findByTestId('commit-proposal-create')).toBeNull();
        expect(screen.findByTestId('commit-plan-stop-after')).toBeTruthy();
    });

    it('keeps Create off while a moved-out commit is empty, and says why', async () => {
        const onCreate = vi.fn();
        const screen = await render(null, { onCreate }, { ...PLAN, groups: [...PLAN.groups, { id: 'empty', message: 'Nothing', rationale: '', changeRefs: [] }] });
        expect(screen.findByTestId('commit-proposal-create')?.props.disabled).toBe(true);
        expect(screen.findByTestId('commit-proposal-create')?.props.accessibilityHint).toBe('commitProposal.footer.emptyGroupReason');
    });

    it('a hook that changed files waits inside its commit for Include or Cancel; earlier commits stay landed', async () => {
        const onIncludeHookChanges = vi.fn();
        const onCancel = vi.fn();
        const screen = await render(application({ status: 'paused', reason: 'hook_content_changed', nextGroupIndex: 1, steps: [
            { groupId: 'one', state: 'published', commitSha: 'a'.repeat(40) },
            { groupId: 'two', state: 'not_published', hookContentChanges: { beforeTreeOid: 'b'.repeat(40), afterTreeOid: 'c'.repeat(40), changes: [{ path: MODAL, kind: 'modified' }] } },
            { groupId: 'three', state: 'pending' },
        ] }), { onIncludeHookChanges, onCancel, readHookDiff: async () => ({ success: true,
            beforeTreeOid: 'b'.repeat(40), afterTreeOid: 'c'.repeat(40), files: [{ path: MODAL, changeKind: 'modified',
                unifiedDiff: `diff --git a/${MODAL} b/${MODAL}\n--- a/${MODAL}\n+++ b/${MODAL}\n@@ -1 +1 @@\n-old\n+hook\n` }] }) });
        expect(screen.findByTestId('commit-group-hook-changed:two')).toBeTruthy();
        expect(screen.findByTestId('commit-group-hook-changed:one')).toBeNull();
        (screen.findByTestId('commit-plan-include-hook')?.props.onPress as () => void)();
        (screen.findByTestId('commit-plan-cancel-commit')?.props.onPress as () => void)();
        expect(onIncludeHookChanges).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('a moved branch refuses the rest, keeps landed commits, and offers a fresh proposal, not a retry', async () => {
        const onProposeAgain = vi.fn();
        const screen = await render(application({ status: 'failed', reason: 'head_moved', nextGroupIndex: 1, steps: [
            { groupId: 'one', state: 'published', commitSha: 'a'.repeat(40) }, { groupId: 'two', state: 'pending' }, { groupId: 'three', state: 'pending' },
        ] }), { onProposeAgain, onCreate: vi.fn(), onMove: vi.fn(), onEditMessage: vi.fn() });
        expect(screen.findByTestId('commit-plan-outcome-head-moved')).toBeTruthy();
        expect(screen.findByTestId('commit-group-edit:one')).toBeNull();
        expect(screen.findByTestId('commit-group-edit:two')).toBeTruthy();
    });

    it('says what the writer knows: the failed hook by name, a landed commit\'s time, and "signed" only when it was', async () => {
        const writer = (patch: Record<string, unknown>) => ({ state: 'not_published' as const, expectedHeadOid: null, expectedRef: 'refs/heads/main', indexReconciliation: 'not_required' as const, ...patch });
        const onAskSession = vi.fn();
        const screen = await render(application({ status: 'failed', reason: 'hook_failed', nextGroupIndex: 1, steps: [
            { groupId: 'one', state: 'published', commitSha: 'a'.repeat(40), publication: writer({ state: 'published', candidateOid: 'a'.repeat(40), committedAtMs: 1_700_000_000_000, signed: false }) },
            { groupId: 'two', state: 'not_published', error: 'eslint: 1 error', publication: writer({ hookName: 'pre-commit' }) }, { groupId: 'three', state: 'pending' },
        ] }), { onCreate: vi.fn(), onAskSession, onEditMessage: vi.fn() });
        const landed = textOf(screen.findByTestId('commit-group-landed-meta') as unknown as Instance);
        expect(landed).toContain('commitProposal.state.landedAt');
        expect(landed).not.toContain('commitProposal.state.signed');
        expect(textOf(screen.findByTestId('commit-group-hook-failed:two') as unknown as Instance)).toContain('commitProposal.outcome.hookFailedBy:{"hook":"pre-commit"}');
        const ask = screen.findAll((node) => (node.type as unknown) === 'RoundButton' && node.props.title === 'commitProposal.outcome.askSessionToFix');
        (ask[0]!.props.onPress as () => void)();
        expect(onAskSession).toHaveBeenCalledTimes(1);
    });

    it('offers Undo right after a proposal is discarded', async () => {
        const onUndoDiscard = vi.fn();
        const screen = await renderScreen(
            <CommitProposalView proposal={null} phase="none" branch="main" modelLabel={null} layout="wide" actions={{}} onUndoDiscard={onUndoDiscard} />,
        );
        expect(screen.findByTestId('commit-proposal-discarded')).toBeTruthy();
    });
});
