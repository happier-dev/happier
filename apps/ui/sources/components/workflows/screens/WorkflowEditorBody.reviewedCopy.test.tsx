import * as React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { WorkflowEditorBody } from './WorkflowEditorBody';

const nativeWindow = vi.hoisted(() => ({ width: 400, height: 800 }));

// Native presentation and navigation are system boundaries; Body, pane owner,
// settings decisions and the storage underneath them remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => nativeWindow });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
    useNavigation: () => ({}),
    useLocalSearchParams: () => ({}),
}));
// This native Markdown SDK is not installed in the source harness. These
// empty-document command cases never render Markdown or exercise its codec.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

beforeEach(() => {
    getStorage().setState({ settings: settingsDefaults, localSettings: localSettingsDefaults });
});
afterEach(async () => { await standardCleanup(); });

describe('Workflow editor reviewed-copy disclosure', () => {
    it.each(['notSaved', 'unsaved', 'failed'] as const)('offers Add and Save in the phone command bar for a %s draft', async (kind) => {
        nativeWindow.width = 390;
        const onSave = vi.fn();
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorBody
            draft={createWorkflowEditorDraft({ draftId: 'phone-commands', blocks: [] })}
            onChange={vi.fn()} onSave={onSave}
            saveStatus={kind === 'failed' ? { kind, reason: null } : { kind }}
            machineName={null} selectedBlockId={null} onSelectBlock={vi.fn()} onCustomizeBlock={vi.fn()}
            composerScope={{ kind: 'machine', machineId: null }} view="steps" onChangeView={vi.fn()}
        /></AppPaneProvider>);
        const bar = screen.findByTestId('workflow-editor-phone-bar');
        expect(bar?.findAll((node) => typeof node.type === 'string' && node.props.testID === 'workflow-editor-phone-add')).not.toHaveLength(0);
        expect(bar?.findAll((node) => typeof node.type === 'string' && node.props.testID === 'workflow-editor-phone-save')).not.toHaveLength(0);
    });
    it.each([400, 1200])('keeps the review disclosure in the page scroll at width %s', async (width) => {
        nativeWindow.width = width;
        const props = {
            // An empty draft is still reviewable: disclosure does not depend on
            // whether an authored workflow currently passes validation.
            draft: createWorkflowEditorDraft({ draftId: 'reviewed-copy', blocks: [] }),
            onChange: vi.fn(),
            onSave: vi.fn(),
            machineName: null,
            selectedBlockId: null,
            onSelectBlock: vi.fn(),
            onCustomizeBlock: vi.fn(),
            composerScope: { kind: 'machine' as const, machineId: null, serverId: null, directory: null, machineHomeDir: null },
            view: 'steps' as const,
            onChangeView: vi.fn(),
            reviewNotice: <Text testID="reviewed-copy-disclosure">Review this unsaved copy</Text>,
        };
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorBody {...props} /></AppPaneProvider>);
        const scroll = screen.findByTestId('workflow-editor-scroll');
        expect(scroll).not.toBeNull();
        expect(scroll?.findAll((node) => typeof node.type === 'string' && node.props.testID === 'reviewed-copy-disclosure')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('reviewed-copy-disclosure')).toHaveLength(1);
    });
});
