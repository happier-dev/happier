import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { createApprovalChecksSceneFixture } from '@/dev/testkit/fixtures/approvalAutomaticChecksFixtures';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { PluginInstallReviewRow } from '@/components/settings/plugins/model/usePluginInstallReviewSet';

installApprovalCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ renderCustomModals: true }).module;
    },
});
const account = createProviderSettingsAccountHarness();
const { PluginInstallReviewSpecimen } = await import('./PluginInstallReviewSpecimen');
const { PluginInstallOnMachinesSheet, readSharedConsentFacts } = await import('@/components/settings/plugins/listing/PluginInstallOnMachines');
const { Modal, ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storage');

afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    await account.reset();
});

it.each((['plain', 'e2ee'] as const).flatMap(mode => (['review', 'settled', 'single'] as const).map(state => ({ mode, state }))))('renders $mode $state approvals after the live inventory drops local rows', async ({ mode, state }) => {
    await account.restore({ serverIdentityId: 'srv_specimen_home', machines: [],
        ...(mode === 'e2ee' ? { e2eeSecret: new Uint8Array(32).fill(17) } : {}) });
    // The dev HTTP overlay forwards unrelated requests to the real Home boundary.
    vi.stubGlobal('fetch', account.home.request);
    const screen = await renderScreen(<ModalProvider><PluginInstallReviewSpecimen state={state} /></ModalProvider>);
    if (state !== 'single') {
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.installOnMachines.target.build-box.switch')).not.toBeNull());
        const machineIds = state === 'review' ? ['build-box', 'lab-pi', 'guest-laptop'] : ['build-box', 'media-server', 'office-nas'];
        for (const machineId of machineIds) {
            await act(async () => {
                screen.findByTestId(`settings.plugins.installOnMachines.target.${machineId}.switch`)?.props.onValueChange(true);
            });
        }
        await screen.pressByTestIdAsync('settings.plugins.installOnMachines.submit');
    }
    await act(async () => { storage.getState().applyArtifacts([], storage.getState().artifacts); });
    await vi.waitFor(() => {
        const text = screen.getTextContent();
        expect(text).not.toContain('approvals.loadError');
        if (state === 'single') {
            expect(screen.findByTestId('approvals.in-place')).not.toBeNull();
        } else if (state === 'review') {
            expect(text).toContain('settingsPlugins.installDeclined');
            expect(text).toContain('actionConfirmations.homeUnavailable');
            expect(text).toContain('This Machine does not allow plugin installation.');
            expect(screen.findByTestId('settings.plugins.installOnMachines.install')?.props.disabled, text).toBe(false);
            // Studio Mac mini and build-box report the same release: its facts read once, above the Machines.
            expect(text.split('settingsPlugins.installReviewSections.identity').length - 1, text).toBe(1);
            expect(screen.findByTestId('settings.plugins.installOnMachines.shared')).not.toBeNull();
            // Its section says what is specific to it: Studio Mac mini waits on this confirm.
            expect(text).toContain('settingsPlugins.multiInstall.ready');
            // A confirm is pending: the reassurance stays.
            expect(text).toContain('settingsPlugins.multiInstall.footerNote');
        } else {
            expect(text).toContain('settingsPlugins.multiInstall.installed');
            expect(text).toContain('settingsPlugins.installDeclined');
            expect(text).toContain('settingsPlugins.multiInstall.superseded');
            expect(text).toContain('This Machine runs Happier 0.2.14');
            expect(text).not.toContain('actionConfirmations.homeUnavailable');
            expect(text.split('settingsPlugins.installReviewSections.identity').length - 1, text).toBe(1);
            // Nothing waits on a confirm any more, so "Nothing installs until you confirm" would be false.
            expect(text).not.toContain('settingsPlugins.multiInstall.footerNote');
        }
    });
});

it('reads a fact once only when every Machine that reported facts reported it identically', () => {
    const identity = (version: string) => ({ key: 'identity', title: 'Identity', value: `Storage Sync · ${version}` });
    const access = { key: 'access', title: 'Required host access', value: 'Storage account' };
    expect(readSharedConsentFacts([[identity('2.4.0'), access], [identity('2.4.0'), access]])).toEqual([identity('2.4.0'), access]);
    // A different version stays with each Machine; what still matches is read once.
    expect(readSharedConsentFacts([[identity('2.4.0'), access], [identity('2.3.9'), access]])).toEqual([access]);
    // A fact one Machine lacks is not common.
    expect(readSharedConsentFacts([[identity('2.4.0'), access], [identity('2.4.0')]])).toEqual([identity('2.4.0')]);
    // One Machine's facts are its own; Machines without facts (unavailable Home, refused) do not count.
    expect(readSharedConsentFacts([[identity('2.4.0'), access], []])).toEqual([]);
});

it('reviews one Machine’s pending check consent and returns it to the mixed bulk install without implicitly approving it', async () => {
    await account.restore({ serverIdentityId: 'srv_bulk_home', machines: [] });
    const serverId = account.serverId;
    const ownerAccountId = 'account-a';
    const now = Date.now();
    const rows: PluginInstallReviewRow[] = ['checked', 'ordinary', 'unevaluated'].map(machineId => {
        const id = `bulk-consent-${machineId}`;
        const input = { machineId, source: { kind: 'marketplace', sourceId: 'acme-catalog', pluginId: 'acme.storage-sync', version: '2.4.0' } };
        const checks = machineId === 'checked'
            ? createApprovalChecksSceneFixture('aconsent', { serverId, accountId: ownerAccountId, nowMs: now, asker: 'person' }).approval.automaticChecks
            : undefined;
        const request = ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: now, updatedAtMs: now, createdBy: { surface: 'system' }, requestedSurface: 'ui',
            actionId: 'plugins.install', actionArgs: input, summary: 'Install Storage Sync',
            executionOriginV1: buildApprovalExecutionOriginV1({ actionId: 'plugins.install', input, targetSessionId: null,
                context: { surface: 'ui', authority: 'present_user', serverId, serverIdentityId: 'srv_bulk_home',
                    runtimeAccountId: ownerAccountId, actionRequestId: id, actionCaller: { kind: 'host' },
                    externalActionTarget: { kind: 'machine', machineId } } }),
            ...(checks ? { automaticChecks: { ...checks, humanApprovalRequired: true,
                selected: checks.selected.map(selected => ({ ...selected, actionIds: ['plugins.install'] })) } } : {}),
            preview: { actionId: 'plugins.install', actionArgs: input, summary: 'Install Storage Sync',
                ...(machineId === 'unevaluated' ? {} : { pluginInstall: {
                    permissionsDisclosure: 'daemonEvaluated', pendingReview: { kind: 'reviewRequired', reviewKind: 'installation',
                        pendingChangeId: `candidate-${machineId}`, reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
                        review: createPluginInstallationReviewFixture({ pluginId: 'acme.storage-sync', displayName: 'Storage Sync', version: '2.4.0' }) },
                } }),
            },
        });
        account.home.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture({
            id, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request), title: request.summary,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: now, updatedAt: now, isDecrypted: true,
        }, ownerAccountId));
        return { kind: 'approval', artifactId: id, serverId, target: { serverIdentityId: 'srv_bulk_home', machineId },
            targetLabel: { machine: machineId, server: 'Home' } };
    });
    const candidates = rows.map(row => ({ target: row.target, displayName: row.targetLabel.machine, serverLabel: 'Home',
        availability: 'online' as const, observation: 'live' as const, observedAt: now }));
    const screen = await renderScreen(<ModalProvider><PluginInstallOnMachinesSheet name="Storage Sync" candidates={candidates}
        initialTarget={rows[0]!.target} review={{ pluginId: 'acme.storage-sync', rows }} run={async () => undefined}
        onClosed={() => undefined} onClose={() => undefined} /></ModalProvider>);
    await screen.pressByTestIdAsync('settings.plugins.installOnMachines.submit');
    // The no-check neighbor stays eligible while consent holds only the checked Machine.
    await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.installOnMachines.outcome.ordinary')).not.toBeNull());
    expect(screen.findByTestId('settings.plugins.installOnMachines.install')?.props.disabled).toBe(false);
    expect(screen.findByTestId('settings.plugins.installOnMachines.outcome.checked')).toBeNull();
    await screen.pressByTestIdAsync('settings.plugins.installOnMachines.install');
    await vi.waitFor(() => expect(JSON.parse(account.home.artifacts(serverId).readPlainBody('bulk-consent-ordinary') ?? 'null')).toMatchObject({
        decision: { kind: 'approve' },
    }));
    const held = ApprovalRequestV2Schema.parse(JSON.parse(account.home.artifacts(serverId).readPlainBody('bulk-consent-checked')!));
    expect(held.decision).toBeUndefined();
    expect(held.automaticChecks?.humanDecision).toBeUndefined();
    expect(held.automaticChecks?.consents[0]?.decision).toBe('pending');
    await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.installOnMachines.withheld.unevaluated')).not.toBeNull());
    expect(ApprovalRequestV2Schema.parse(JSON.parse(account.home.artifacts(serverId).readPlainBody('bulk-consent-unevaluated')!)).decision)
        .toBeUndefined();
    expect(screen.findByTestId('settings.plugins.installOnMachines.review.checked')).not.toBeNull();
    await screen.pressByTestIdAsync('settings.plugins.installOnMachines.review.checked');
    await vi.waitFor(() => expect(screen.findByTestId('approvals.automatic-checks:consent')).not.toBeNull());
    expect(screen.getTextContent()).toContain('workflows.triggers.checks.allow');
    expect(screen.getTextContent()).toContain('workflows.triggers.checks.skip');
    await screen.pressByTestIdAsync('approvals.reject');
    await vi.waitFor(() => expect(JSON.parse(account.home.artifacts(serverId).readPlainBody('bulk-consent-checked') ?? 'null')).toMatchObject({
        status: 'open', automaticChecks: { consents: [{ decision: 'skip' }] },
    }));
    const updated = ApprovalRequestV2Schema.parse(JSON.parse(account.home.artifacts(serverId).readPlainBody('bulk-consent-checked')!));
    expect(updated.decision).toBeUndefined();
    expect(updated.automaticChecks?.humanDecision).toBeUndefined();
    // Closing the native/modal presentation boundary returns to the already-mounted bulk sheet.
    const openedReview = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    const modalId = vi.mocked(Modal.show).mock.results.at(-1)?.value;
    if (!openedReview || typeof modalId !== 'string') throw new Error('Expected the in-place approval review');
    await act(async () => { openedReview.onRequestClose?.(); Modal.hide(modalId); });
    // The canonical Artifact update reaches the existing row; the next bulk press includes this Machine.
    await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.installOnMachines.outcome.checked')).not.toBeNull());
    expect(screen.findByTestId('settings.plugins.installOnMachines.install')?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('settings.plugins.installOnMachines.install');
    await vi.waitFor(() => expect(JSON.parse(account.home.artifacts(serverId).readPlainBody('bulk-consent-checked') ?? 'null')).toMatchObject({
        decision: { kind: 'approve' }, automaticChecks: { humanDecision: { kind: 'approve' }, consents: [{ decision: 'skip' }] },
    }));
    await screen.unmount();
});
