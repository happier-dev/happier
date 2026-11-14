import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

import { renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useHomeTeamCredentialModelCatalog } = await import('./useHomeTeamCredentialModelCatalog');
const { SessionModelPicker } = await import('@/components/sessions/modelPicker/SessionModelPicker');
const { sessionModelSelectionKey } = await import('@/components/sessions/modelPicker/sessionModelSelectionKey');
const { buildNewSessionConnectedServicesSelectionListModel } = await import('@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');

beforeEach(async () => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});
afterEach(async () => {
    standardCleanup();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

describe('Team catalog private labels in the model picker', () => {
    it.each([{ locked: false, available: false }, { locked: true, available: false }, { locked: false, available: true }])(
        'renders recipient labels and selects healthy models (locked=$locked, available=$available)', async ({ locked, available }) => {
        const agentTargetKey = 'agent:happier.agent.pi/pi';
        const serverId = await home.addHome({ name: 'Muse Home', serverUrl: 'https://muse-labels.example.test',
            accountId: 'recipient', teamsEnabled: true, credentialResourcesEnabled: true });
        home.answer(serverId, '/v1/teams/list', { body: { items: [teamSummaryFixture({ id: 'team-1' })], nextCursor: null } });
        const resources = ['muse-one', 'muse-two'].map(id => TeamCredentialResourceCatalogEntryV1Schema.parse({
            id, teamId: 'team-1', resourceRevision: 1,
            // The recipient read carrier from READY125, including legacyPlaintext.
            displayName: locked
                ? { content: { t: 'encrypted', c: encodeBase64(new Uint8Array(40).fill(7), 'base64') }, recipientEnvelope: null }
                : { content: { t: 'plain', v: `Shared ${id}` }, recipientEnvelope: null, legacyPlaintext: true },
            readiness: available ? { kind: 'available' } : { kind: 'broker_unavailable' }, recoveryAction: available ? null : 'source_owner_action',
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            connectedServiceSelections: [{ source: 'team_resource', resourceId: id, deliveryMode: 'brokered' }],
            providerModels: available ? [{
                selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: id,
                    expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey, modelId: `${id}-model` },
                descriptor: { id: `${id}-model`, name: `${id} model` }, sourceRevision: 'source-1', availability: 'available',
                application: { agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'responses', protocol: 'openai-responses' },
            }] : [],
            sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.muse', localId: 'muse-account' } },
        }));
        home.answer(serverId, '/v1/teams/credential-resources/entitled/list', { body: { resources, nextCursor: null } });
        home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', { body: { resources, nextCursor: null, failures: [] } });
        const select = vi.fn();
        function Picker() {
            const catalog = useHomeTeamCredentialModelCatalog({ serverId, enabled: true, declarationProjection: null });
            const connected = buildNewSessionConnectedServicesSelectionListModel({
                supportedServiceIds: ['happier.agent.muse/muse-account'], profileOptionsByServiceId: {}, groupOptionsByServiceId: {},
                bindingsByServiceId: {}, teamCredentialResources: catalog.resources, teamCredentialDisplayNames: catalog.displayNames,
                nativeRoute: { agentTargetKey, active: true }, declarationContext: { kind: 'account' },
                setBindingForService: select, onOpenSettings: () => {}, translate: t,
                resolveServiceTitle: () => 'Muse', renderRowIcon: () => null, renderBrowseMark: () => null, renderSettingsIcon: () => null,
            });
            const connectedNames = connected.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options.map(option => option.label) : []);
            return <><span>{connectedNames}</span><SessionModelPicker agentTargetKey={agentTargetKey} declarationContext={{ kind: 'account' }}
                nativeModels={[]} providerGroups={[]} providerProjectionAuthoritative selected={null} onSelect={vi.fn()}
                onSelectTeamCredentialModel={select}
                teamCredentialResources={catalog.resources} teamCredentialDisplayNames={catalog.displayNames}
                teamNameById={catalog.teamNameById} homeNameByTeamId={catalog.homeNameByTeamId} /></>;
        }
        const screen = await renderScreen(<Picker />);
        await waitForHomeGovernance(() => {
            const rendered = screen.getTextContent();
            expect(rendered).toContain(locked ? t('common.unavailable') : 'Shared muse-one');
            if (!locked) expect(rendered).toContain('Shared muse-two');
            expect(rendered).not.toContain(encodeBase64(new Uint8Array(40).fill(7), 'base64'));
            expect(rendered).not.toContain('[object Object]');
        });
        if (available) {
            const chosen = resources[1]!.providerModels[0]!.selection;
            await waitForHomeGovernance(() => {
                expect(screen.findByTestId(`model-picker-overlay-option:${sessionModelSelectionKey(chosen)}`)?.props.accessibilityLabel)
                    .toContain('Shared muse-two');
            });
            await screen.pressByTestIdAsync(`model-picker-overlay-option:${sessionModelSelectionKey(chosen)}`);
            expect(select).toHaveBeenCalledWith(chosen);
        }
    });
});
