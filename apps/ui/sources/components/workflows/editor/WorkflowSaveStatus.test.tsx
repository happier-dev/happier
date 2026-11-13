import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { applyWorkflowDefinitionEditsV1, WorkflowDefinitionEditOpV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});
// Radix owns the DOM boundary; Compare's modal custody and chrome stay real.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});

// Module transform is paid once, outside any single case's time budget.
beforeAll(async () => {
    await import('./WorkflowSaveStatus');
}, 300_000);

afterEach(async () => {
    await standardCleanup();
});

const draft = {
    draftId: 'local-draft',
    name: 'Review',
    version: 1 as const,
    defaults: {},
    inputs: [],
    blocks: [{
        kind: 'step' as const,
        id: 'review',
        document: { text: 'Review local changes', references: [], attachments: [] },
        input: [],
        result: { kind: 'text' as const },
    }],
};

describe('WorkflowSaveStatus', () => {
    it.each(['local', 'current', 'identical', 'non-role'] as const)(
        'compares canonical authored definitions after a %s edit', async (change) => {
            const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
            const role = { roleId: 'reviewer', name: 'Reviewer', instructions: 'Review', runsAs: { kind: 'session' } };
            const base = applyWorkflowDefinitionEditsV1<WorkflowEditorDraft>(draft, [WorkflowDefinitionEditOpV1Schema.parse({ kind: 'upsert_role', role })]);
            if (!base.ok) throw new Error('role_edit_failed');
            const edited = applyWorkflowDefinitionEditsV1(base.draft, [WorkflowDefinitionEditOpV1Schema.parse(change === 'non-role'
                ? { kind: 'rename', name: 'Changed' }
                : { kind: 'upsert_role', role: { ...role, instructions: 'Check' } })]);
            if (!edited.ok) throw new Error('role_edit_failed');
            const localDraft = change === 'local' || change === 'identical' ? edited.draft : base.draft;
            const currentDraft = { ...(change === 'local' ? base.draft : edited.draft), draftId: 'current' };
            const { ModalProvider } = await import('@/modal/ModalProvider');
            // Compare opens the two documents in the canonical card, which the modal host renders.
            const screen = await renderScreen(<ModalProvider><WorkflowSaveStatus
                state={{ kind: 'conflict', conflict: { currentDraft, currentRevision: { headerVersion: 2, bodyVersion: 2 } } }}
                localDraft={localDraft} onSaveAsCopy={() => {}} testIDPrefix="roles" /></ModalProvider>);
            const documents = () => screen.findAll(node => typeof node.type === 'string' && node.props.selectable === true)
                .map(node => String(node.props.children));
            // Comparison content is only materialized while the person asks to inspect it.
            expect(documents()).toHaveLength(0);
            await screen.pressByTestIdAsync('roles-compare');
            const panes = documents();
            expect(panes).toHaveLength(2);
            const local: unknown = JSON.parse(panes[0]!);
            const current: unknown = JSON.parse(panes[1]!);
            const rolesMatch = (value: unknown, expected: unknown) => value !== null && typeof value === 'object'
                && 'roles' in value && JSON.stringify(value.roles) === JSON.stringify(expected);
            // Boolean assertions keep authored content out of failure diagnostics.
            if (change === 'local' || change === 'current') {
                expect(rolesMatch(local, localDraft.roles)).toBe(true);
                expect(rolesMatch(current, currentDraft.roles)).toBe(true);
            }
            expect(panes[0] === panes[1]).toBe(change === 'identical');
            if (change === 'non-role') {
                expect(typeof current === 'object' && current !== null && 'name' in current && current.name === edited.draft.name).toBe(true);
            }
            // Closing the card is WorkflowSaveStatus.compare.test's toggle case.
        },
    );

    it('installs no saved-age clock while its retained editor is hidden, then resumes current age on presentation', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        vi.useFakeTimers();
        const now = Date.UTC(2026, 9, 23, 12);
        vi.setSystemTime(now);
        const census = installTimerCensus(stack => stack.includes('WorkflowSaveStatus.tsx') ? 'save-age' : null);
        const content = <WorkflowSaveStatus state={{ kind: 'saved', savedAtMs: now - 120_000 }} localDraft={draft}
            onSave={() => {}} onSaveAsCopy={() => {}} testIDPrefix="clock" />;
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active={false}>{content}</PluginSurfaceFocusEligibilityProvider>);
        try {
            expect(census.read().filter(timer => timer.consumer === 'save-age')).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { vi.advanceTimersByTime(60_000); });
            // A visible second pane still ages even when it does not own keyboard focus.
            await screen.update(<PluginSurfaceFocusEligibilityProvider active={false} presentationActive>{content}</PluginSurfaceFocusEligibilityProvider>);
            expect(census.read().filter(timer => timer.consumer === 'save-age')).toEqual([
                { kind: 'interval', delayMs: 60_000, consumer: 'save-age' },
            ]);
            expect(screen.getTextContent()).toContain('workflows.page.saveStatus.savedAge');
            expect(screen.getTextContent()).toContain(JSON.stringify({ age: formatRelativeTimeShort(now - 120_000, now + 60_000) }));
            await act(async () => { vi.advanceTimersByTime(60_000); });
            await screen.update(<PluginSurfaceFocusEligibilityProvider active={false}>{content}</PluginSurfaceFocusEligibilityProvider>);
            expect(census.read().filter(timer => timer.consumer === 'save-age')).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await screen.unmount();
            census.stop();
            vi.useRealTimers();
        }
    });

    it('is its own receipt: one element reads Unsaved changes with Save, then Saving…, then Saved just now', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const onSave = vi.fn();
        const now = Date.UTC(2026, 8, 30, 12, 0, 0);
        type State = React.ComponentProps<typeof WorkflowSaveStatus>['state'];
        let setState: (state: State) => void = () => {};
        function Harness() {
            const [state, set] = React.useState<State>({ kind: 'unsaved' });
            setState = set;
            return React.createElement(WorkflowSaveStatus, {
                state,
                localDraft: draft,
                onSave,
                onSaveAsCopy: vi.fn(),
                nowMs: now,
                testIDPrefix: 'workflow-editor',
            });
        }
        const screen = await renderScreen(React.createElement(Harness));
        const update = async (state: State) => { await act(async () => { setState(state); }); };

        const status = () => screen.findByTestId('workflow-editor-save-status');
        expect(status()).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.unsaved');
        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(onSave).toHaveBeenCalledTimes(1);

        await update({ kind: 'saving' });
        expect(status()).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.saving');
        // While saving, Save is not repeatable.
        expect(screen.findByTestId('workflow-editor-save')).toBeNull();

        await update({ kind: 'saved', savedAtMs: now - 10_000 });
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.savedJustNow');
        // No raw revision ("h1 · b2") is ever the receipt.
        expect(screen.getTextContent()).not.toMatch(/h\d+ · b\d+/);

        await update({ kind: 'saved', savedAtMs: now - 3 * 60_000 });
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.savedAge');
    });

    it('reads Not saved yet for a pristine draft, with no Save and no validation text', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const screen = await renderScreen(React.createElement(WorkflowSaveStatus, {
            state: { kind: 'notSaved' },
            localDraft: draft,
            onSave: vi.fn(),
            onSaveAsCopy: vi.fn(),
            testIDPrefix: 'workflow-editor',
        }));
        expect(screen.getTextContent()).toBe('workflows.page.saveStatus.notSaved');
        expect(screen.findByTestId('workflow-editor-save')).toBeNull();
    });

    it('keeps edits after a failed save and offers Try again through the same Save', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const onSave = vi.fn();
        const screen = await renderScreen(React.createElement(WorkflowSaveStatus, {
            state: { kind: 'failed', reason: 'The server did not answer.' },
            localDraft: draft,
            onSave,
            onSaveAsCopy: vi.fn(),
            testIDPrefix: 'workflow-editor',
        }));
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.failed');
        await screen.pressByTestIdAsync('workflow-editor-save-retry');
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('retains the local document in a conflict and offers comparison plus save-as-copy recovery', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const saveAsCopy = vi.fn();
        const currentDraft = { ...draft, draftId: 'current-draft', blocks: [{ ...draft.blocks[0], document: { ...draft.blocks[0].document, text: 'Review remote changes' } }] };
        const { ModalProvider } = await import('@/modal/ModalProvider');
        const screen = await renderScreen(<ModalProvider>{React.createElement(WorkflowSaveStatus, {
            state: { kind: 'conflict', conflict: { currentDraft, currentRevision: { headerVersion: 3, bodyVersion: 3 } } },
            localDraft: draft,
            onSave: vi.fn(),
            onSaveAsCopy: saveAsCopy,
            testIDPrefix: 'workflow-editor',
        })}</ModalProvider>);

        expect(screen.getTextContent()).toContain('workflows.save.conflictTitle');
        expect(screen.getTextContent()).toContain('workflows.save.conflictBody');
        await screen.pressByTestIdAsync('workflow-editor-compare');
        expect(screen.getTextContent()).toContain('Review local changes');
        expect(screen.getTextContent()).toContain('Review remote changes');
        await screen.pressByTestIdAsync('workflow-editor-save-as-copy');
        expect(saveAsCopy).toHaveBeenCalledTimes(1);
    });

    it('omits Compare when the current Artifact cannot be read while keeping save-as-copy available', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const screen = await renderScreen(React.createElement(WorkflowSaveStatus, {
            state: { kind: 'conflict', conflict: { currentDraft: null, currentRevision: null } },
            localDraft: draft,
            onSave: vi.fn(),
            onSaveAsCopy: vi.fn(),
            testIDPrefix: 'workflow-editor',
        }));

        expect(screen.findByTestId('workflow-editor-compare')).toBeNull();
        expect(screen.findByTestId('workflow-editor-save-as-copy')).not.toBeNull();
    });
});
