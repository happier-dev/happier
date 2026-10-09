import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { NewSessionManagedMachineDraftModel } from '../newSessionScreenModelTypes';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { t } from '@/text';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Positioning belongs to the DOM boundary; keep badge and popover content real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
afterEach(() => standardCleanup());

import { buildNewSessionScreenVariantModel } from './buildNewSessionScreenVariantModel';

const selection = createManagedMachineSelectionDraft({
    selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 3 },
    receipt: {
        launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1,
            name: 'Guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
        prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
        retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        preset: { id: 'preset', revision: 3, name: 'My guest' },
    },
});
const operation: ActionOperationSnapshotV1 = {
    version: 1, operationId: 'install', revision: 2, actionId: 'machines.managed.acquire',
    state: 'running', scope: { accountId: 'account', machineId: 'controller' },
    title: 'Create Guest', createdAt: 1, startedAt: 1, cancellation: 'supported',
    progress: { kind: 'phase', phase: 'native.boot', label: 'Waiting for guest SSH' },
};

function buildVariant(useEnhancedSessionWizard: boolean, managedMachineDraft: NewSessionManagedMachineDraftModel) {
    const ordinaryBadge = { key: 'ordinary', label: 'Ordinary status' };
    // Only the projection boundary is under test; unrelated form props are never rendered.
    const params = {
        useEnhancedSessionWizard, popoverBoundaryRef: React.createRef(), launchOverlay: null,
        simplePanelProps: { statusBadges: [ordinaryBadge] }, checkoutCreationDraft: null,
        setCheckoutCreationDraft: () => {}, wizardLayoutProps: {}, wizardProfilesProps: {},
        wizardAgentProps: {}, wizardMachineProps: {}, wizardFooterProps: { statusBadges: [ordinaryBadge] },
        managedMachineDraft,
    } as unknown as Parameters<typeof buildNewSessionScreenVariantModel>[0];
    const model = buildNewSessionScreenVariantModel(params);
    return model.variant === 'simple' ? model.simpleProps : model.wizardProps.footer;
}

describe('buildNewSessionScreenVariantModel', () => {
    it('projects Set up after Join from the durable stage instead of showing allocation waiting', async () => {
        const draft: NewSessionManagedMachineDraftModel = {
            selection, acquisition: { requestId: 'send', managedId: 'paid', selection: selection.selection },
            select: vi.fn(), retryInstallation: vi.fn(),
            progress: { kind: 'setup_pending', managedId: 'paid', machineId: 'guest', state: 'pending',
                environmentSetup: { environment: { setupScript: 'echo setup' }, state: 'pending' } },
        };
        const badge = buildVariant(false, draft).statusBadges?.find(item => item.key === 'managed-machine-progress');
        expect(badge?.label).toBe(t('managedMachines.creation.setup'));
        expect(badge?.tone).toBe('neutral');
        const screen = await renderScreen(React.createElement(React.Fragment, null, badge?.renderPopover?.({
            open: true, anchorRef: React.createRef(), onRequestClose: () => {},
        })));
        const checklist = screen.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-step')[0];
        expect(checklist?.props.steps.map((step: { stepId: string; status: string }) => [step.stepId, step.status])).toEqual([
            ['create', 'done'], ['install', 'done'], ['join', 'done'], ['setup', 'pending'],
        ]);
        await screen.unmount();
    });
    it('shows only observed stages and binds cancellation and archive choice to local draft actions', async () => {
        const canceled = vi.fn();
        const changed = vi.fn();
        const draft: NewSessionManagedMachineDraftModel = {
            selection, acquisition: { requestId: 'send', managedId: 'paid', selection: selection.selection },
            select: vi.fn(), retryInstallation: vi.fn(), cancel: canceled, updateArchiveEffect: changed,
            progress: { kind: 'acquiring', managedId: 'paid', operation },
        };
        const badge = buildVariant(false, draft).statusBadges?.find(item => item.key === 'managed-machine-progress');
        expect(badge).toBeDefined();
        const screen = await renderScreen(React.createElement(React.Fragment, null, badge?.renderPopover?.({
            open: true, anchorRef: React.createRef(), onRequestClose: () => {},
        })));
        const checklist = screen.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-step')[0];
        expect(checklist?.props.steps).toEqual([{ stepId: 'native.boot', title: 'Waiting for guest SSH', status: 'active' }]);
        expect(screen.getTextContent()).not.toContain('No bill');
        const archive = screen.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-archive')[0];
        await act(async () => archive?.props.onSelectTab('stop'));
        expect(changed).toHaveBeenCalledWith('stop');
        await act(async () => screen.findByTestId('managed-machine-progress-cancel')?.props.onPress());
        expect(canceled).toHaveBeenCalledOnce();
    });

    it.each([false, true])('mounts observed managed progress alongside ordinary composer status (wizard=%s)', (wizard) => {
        const draft: NewSessionManagedMachineDraftModel = {
            selection, acquisition: { requestId: 'send', managedId: 'paid', selection: selection.selection },
            select: vi.fn(), retryInstallation: vi.fn(),
            progress: { kind: 'acquiring', managedId: 'paid', operation },
        };
        const props = buildVariant(wizard, draft);
        expect(props.statusBadges?.map(badge => badge.key)).toEqual(['ordinary', 'managed-machine-progress']);
        expect(props.statusBadges?.[1]).toMatchObject({ label: 'Waiting for guest SSH', tone: 'active' });
    });

    it('uses the operation owner observation when the controller is no longer reachable', () => {
        const draft: NewSessionManagedMachineDraftModel = {
            selection, acquisition: { requestId: 'send', managedId: 'paid', selection: selection.selection },
            select: vi.fn(), retryInstallation: vi.fn(),
            progress: { kind: 'acquiring', managedId: 'paid', operation, operationObservation: 'unavailable' },
        };
        const badge = buildVariant(false, draft).statusBadges?.find(item => item.key === 'managed-machine-progress');
        expect(badge?.label).not.toBe('Waiting for guest SSH');
        expect(badge?.tone).toBe('neutral');
    });

    it('offers installation retry only when the creation owner confirmed a retained native resource', async () => {
        const retryInstallation = vi.fn();
        const failedOperation: ActionOperationSnapshotV1 = { ...operation, state: 'failed', settledAt: 2,
            error: { errorCode: 'installation_failed', error: 'Native install failed' } };
        for (const available of [false, true]) {
            const draft: NewSessionManagedMachineDraftModel = {
                selection, acquisition: { requestId: 'send', managedId: 'paid', selection: selection.selection },
                select: vi.fn(), retryInstallation,
                progress: { kind: 'failed', code: 'installation_failed', managedId: 'paid',
                    operation: failedOperation, retryInstallationAvailable: available },
            };
            const badge = buildVariant(false, draft).statusBadges?.find(item => item.key === 'managed-machine-progress');
            const screen = await renderScreen(React.createElement(React.Fragment, null, badge?.renderPopover?.({
                open: true, anchorRef: React.createRef(), onRequestClose: () => {},
            })));
            const retry = screen.findByTestId('managed-machine-progress-retry');
            expect(Boolean(retry)).toBe(available);
            if (retry) await act(async () => retry.props.onPress());
            await screen.unmount();
        }
        expect(retryInstallation).toHaveBeenCalledOnce();
    });

    it.each([false, true])('removes creation progress after retirement or real enrollment (wizard=%s)', (wizard) => {
        const draft: NewSessionManagedMachineDraftModel = {
            selection, acquisition: null, select: vi.fn(), retryInstallation: vi.fn(), progress: { kind: 'idle' },
        };
        for (const managed of [draft, { ...draft, selection: null,
            progress: { kind: 'enrollment_pending' as const, managedId: 'paid' } },
            { ...draft, progress: { kind: 'ready' as const, managedId: 'paid', machineId: 'guest' } }]) {
            expect(buildVariant(wizard, managed).statusBadges?.map(badge => badge.key)).toEqual(['ordinary']);
        }
    });

    it('preserves wizard section presentation and column settings in wizard props', () => {
        const sectionPresentation = {
            machines: 'dropdown',
            paths: 'dropdown',
        } as const;

        const model = buildNewSessionScreenVariantModel({
            useEnhancedSessionWizard: true,
            popoverBoundaryRef: { current: null },
            launchOverlay: null,
            simplePanelProps: {},
            checkoutCreationDraft: null,
            setCheckoutCreationDraft: () => {},
            wizardLayoutProps: {},
            wizardSectionPresentation: sectionPresentation,
            wizardUseColumnLayout: true,
            wizardProfilesProps: {},
            wizardAgentProps: {},
            wizardMachineProps: {},
            wizardFooterProps: {},
        } as any);

        expect(model.variant).toBe('wizard');
        if (model.variant !== 'wizard') return;
        expect(model.wizardProps.sectionPresentation).toBe(sectionPresentation);
        expect(model.wizardProps.useColumnLayout).toBe(true);
    });

    it('opens a Bot draft in the ordinary composer even when the person prefers the wizard (lab b-new: no wizard)', () => {
        const model = buildNewSessionScreenVariantModel({
            useEnhancedSessionWizard: true,
            popoverBoundaryRef: { current: null },
            launchOverlay: null,
            simplePanelProps: {},
            checkoutCreationDraft: null,
            setCheckoutCreationDraft: () => {},
            wizardLayoutProps: {},
            wizardProfilesProps: {},
            wizardAgentProps: {},
            wizardMachineProps: {},
            wizardFooterProps: {},
            botCreation: { nameStore: {}, onSessionNameChange: () => {} },
        } as any);
        expect(model.variant).toBe('simple');
        expect(model.botCreation).toBeDefined();
    });
});
