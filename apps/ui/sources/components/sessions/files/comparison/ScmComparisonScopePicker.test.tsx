import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierInputPickerProvider } from '@happier-dev/plugin-ui/presentation';
import type { PluginUiInputTypeProjection } from '@/sync/domains/plugins/ui/projection';
import { renderScreen } from '@/dev/testkit';
import { createInputTypePickerPort } from '@/components/sessions/actions/inputTypePickerPort';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { filesComparisonScopeOptionKey, type FilesComparisonScopeOption } from './filesComparison';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});

const comparison = { kind: 'pullRequest' as const, locator: { providerId: 'example-forge', repository: 'example/repository', number: 17,
    sourceAction: { action: { pluginId: 'happier.example.source', localId: 'read-comparison' }, input: { number: 17 } } } };

async function mount(settlement: unknown, available = true, pluginId = 'happier.triage', phone = false) {
    const { ScmComparisonScopePicker } = await import('./ScmComparisonScopePicker');
    const { ScmComparisonPhoneHeader } = await import('./ScmComparisonPhoneHeader');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { TRIAGE_PLUGIN } = await import('@happier-dev/plugins-triage/manifest');
    const definition = TRIAGE_PLUGIN.manifest.contributes?.inputTypes?.find(type => type.semantic === 'scmPullRequestComparison');
    if (!definition) throw new Error('Missing Triage PR comparison contribution');
    const identity = { pluginId, localId: definition.id };
    const entry = { id: `${pluginId}/${definition.id}`, pluginId, pluginVersion: '0.0.0', occurrenceId: 'current', definition } satisfies PluginUiInputTypeProjection;
    const entries = available ? { [entry.id]: entry } : {};
    const port = createInputTypePickerPort({
        readInputTypes: () => entries,
        resolveType: requested => available && requested.pluginId === identity.pluginId && requested.localId === identity.localId
            ? { identity, occurrenceId: entry.occurrenceId, definition } : null,
        canOpenPicker: () => available, openPicker: async () => settlement,
    });
    let mounts = 0;
    function ProjectComparison() {
        React.useEffect(() => { mounts++; }, []);
        const [current, setCurrent] = React.useState<SessionScmReviewComparison>({ kind: 'workingTree' });
        const scope: React.ComponentProps<typeof ScmComparisonScopePicker> = {
            options: [{ comparison: null, sourceKind: 'pullRequest', group: 'explainOnly',
                label: 'Pull request', subtitle: 'Select source evidence', fileCount: null }],
            current, currentLabel: current.kind, fileCount: null, onSelect: setCurrent,
        };
        return phone ? <ScmComparisonPhoneHeader view="files" views={['files']} scope={scope}
            onSelectView={() => {}} onStartReview={null} /> : <ScmComparisonScopePicker {...scope} />;
    }
    const screen = await renderScreen(<HappierInputPickerProvider port={port}><ProjectComparison /></HappierInputPickerProvider>);
    const menu = () => screen.root.find(node => node.type === DropdownMenu && node.props.testID !== 'scm-comparison-phone-actions');
    return { menu, screen, mounts: () => mounts };
}

describe('comparison picker return', () => {
    it('keeps identical Session selectors qualified by their admitted evidence Session', async () => {
        const { ScmComparisonScopePicker } = await import('./ScmComparisonScopePicker');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelect = vi.fn();
        const options: FilesComparisonScopeOption[] = ['session-a', 'session-b'].map(evidenceSessionId => ({
            comparison: { kind: 'session' }, evidenceSessionId, sourceKind: 'session', group: 'explainOnly',
            label: evidenceSessionId, subtitle: 'Session evidence', fileCount: null,
        }));
        const screen = await renderScreen(<ScmComparisonScopePicker options={options} current={{ kind: 'session' }}
            currentEvidenceSessionId="session-a" currentLabel="Session A" fileCount={null} onSelect={onSelect} />);
        const menu = screen.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { checked: boolean }) => item.checked)).toEqual([true, false]);
        expect(menu.props.items[0].id).not.toBe(menu.props.items[1].id);
        await act(async () => { menu.props.onSelect(filesComparisonScopeOptionKey(options[1])); });
        expect(onSelect).toHaveBeenCalledWith({ kind: 'session' }, 'session-b');
        await screen.unmount();
    });
    it.each(['happier.triage', 'example.other-picker'])('applies contributed PR evidence through its semantic (%s)', async pluginId => {
        const { menu, screen, mounts } = await mount({ kind: 'completed', input: comparison }, true, pluginId);
        expect(menu().props.items).toEqual([expect.objectContaining({ id: 'pullRequest', disabled: false })]);
        await act(async () => { menu().props.onSelect('pullRequest'); });
        expect(menu().props.selectedId).toBe(JSON.stringify(['pullRequest', comparison.locator]));
        expect(mounts()).toBe(1);
        await screen.unmount();
    });
    it('preserves the previous comparison on cancel and does not offer an unavailable source', async () => {
        const cancelled = await mount({ kind: 'cancelled' });
        await act(async () => { cancelled.menu().props.onSelect('pullRequest'); });
        expect(cancelled.menu().props.selectedId).toBe('workingTree');
        expect(cancelled.mounts()).toBe(1);
        await cancelled.screen.unmount();
        const unavailable = await mount({ kind: 'completed', input: comparison }, false);
        expect(unavailable.menu().props.items).toEqual([]);
        await unavailable.screen.unmount();
    });
    it.each([true, false])('uses the same semantic lookup in the phone header (contributor: %s)', async available => {
        const { menu, screen } = await mount({ kind: 'completed', input: comparison }, available, 'example.phone-picker', true);
        expect(menu().props.items).toHaveLength(available ? 1 : 0);
        if (available) {
            await act(async () => { menu().props.onSelect('pullRequest'); });
            expect(menu().props.selectedId).toBe(JSON.stringify(['pullRequest', comparison.locator]));
        }
        await screen.unmount();
    });
    it('retains an already-bound PR comparison when no picker contributes', async () => {
        const { ScmComparisonScopePicker } = await import('./ScmComparisonScopePicker');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelect = vi.fn();
        const option: FilesComparisonScopeOption = { comparison, sourceKind: 'pullRequest', group: 'explainOnly',
            label: 'Saved pull request', subtitle: 'Source evidence', fileCount: null };
        const screen = await renderScreen(<ScmComparisonScopePicker options={[option]} current={comparison}
            currentLabel="Saved pull request" fileCount={null} onSelect={onSelect} />);
        const menu = screen.findByType(DropdownMenu);
        expect(menu.props.items).toEqual([expect.objectContaining({ checked: true, disabled: false })]);
        await act(async () => { menu.props.onSelect(filesComparisonScopeOptionKey(option)); });
        expect(onSelect).toHaveBeenCalledWith(comparison, undefined);
        await screen.unmount();
    });
});
