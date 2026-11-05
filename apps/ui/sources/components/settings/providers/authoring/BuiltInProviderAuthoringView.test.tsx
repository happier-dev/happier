import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';

import {
    findTestInstanceByTypeContainingText,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

function findAnnouncingAncestor(node: ReactTestInstance): ReactTestInstance | null {
    let current = node.parent;
    while (current) {
        if (
            current.props.accessibilityLiveRegion !== undefined
            || current.props.role === 'status'
            || current.props['aria-live'] !== undefined
        ) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

describe('BuiltInProviderAuthoringView', () => {
    afterEach(standardCleanup);

    it('keeps the reviewed Connect action and Cancel directly available in phone navigation', async () => {
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const discard = vi.fn();
        const screen = await renderScreen(<DestinationInstanceHost tabId="provider-draft"
            ref={{ kind: 'settings', params: {} }} pathname="/settings/providers/new" focused visible phone
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <BuiltInProviderAuthoringView machineId="machine-a" currentMachineName="Mac" providerName="Provider"
                icon={null} provenance="first_party" previewCredential={null} endpointTemplates={[]} endpointValues={{}}
                secretSelected={false} savedSecretSelectionEnabled preview={null} previewLoading={false}
                savePending={false} error={null} secondaryTextColor="#777" warningColor="#b70"
                onPickSecret={() => {}} onChooseCandidate={() => {}} onEndpointChange={() => {}}
                onSave={() => {}} onDiscard={discard} />
        </DestinationInstanceHost>);
        expect(screen.findHostByTestId('settings-provider-authoring-connect')).not.toBeNull();
        expect(screen.findHostByTestId('settings-provider-authoring-connect')!.props.disabled).toBe(true);
        expect(screen.findHostByTestId('settings-provider-authoring-cancel')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-provider-authoring-cancel');
        expect(discard).toHaveBeenCalledOnce();
    });

    it('politely announces destination resolution without making static info rows live', async () => {
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const screen = await renderScreen(
            <BuiltInProviderAuthoringView
                machineId="machine-a"
                currentMachineName="Mac"
                providerName="Provider"
                icon={null}
            provenance="external"
            previewCredential={null}
            endpointTemplates={[]}
            endpointValues={{}}
            secretSelected={false}
            savedSecretSelectionEnabled
                preview={null}
                previewLoading
                savePending={false}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
            onPickSecret={vi.fn()}
            onChooseCandidate={vi.fn()}
            onEndpointChange={vi.fn()}
                onSave={vi.fn()}
                onDiscard={vi.fn()}
            />,
        );

        const resolvingStatus = screen.findByTestId('settings-provider-authoring-destination-status');
        expect(resolvingStatus?.props.accessibilityLiveRegion).toBe('polite');
        expect(resolvingStatus?.props.role).toBe('status');
        expect(resolvingStatus?.props['aria-live']).toBe('polite');

        const staticInfoText = findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'settingsProviders.compatibility.experimental',
        );
        expect(staticInfoText).toBeDefined();
        expect(findAnnouncingAncestor(staticInfoText!)).toBeNull();
    });

    it('labels an endpoint on a plugin-contributed wire protocol with the protocol it declared', async () => {
        // A protocol the host does not bundle has no bundled copy string. The
        // field must show the declared protocol id rather than another
        // protocol's label or an unresolved translation key.
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const screen = await renderScreen(
            <BuiltInProviderAuthoringView
                machineId="machine-a"
                currentMachineName="Mac"
                providerName="Acme"
                icon={null}
                provenance="external"
                previewCredential={null}
                endpointTemplates={[
                    { id: 'acme', protocol: 'acme-wire-v1' },
                    { id: 'responses', protocol: 'openai-responses' },
                ]}
                endpointValues={{ acme: 'https://api.acme.example/v1' }}
                secretSelected={false}
            savedSecretSelectionEnabled
                preview={null}
                previewLoading={false}
                savePending={false}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
                onPickSecret={vi.fn()}
                onChooseCandidate={vi.fn()}
                onEndpointChange={vi.fn()}
                onSave={vi.fn()}
                onDiscard={vi.fn()}
            />,
        );

        expect(screen.findByTestId('settings-provider-authoring-endpoint-acme')).toBeTruthy();
        const text = screen.getTextContent();
        // The contributed protocol is shown as declared, never as an
        // unresolved `settingsProviders.authoring.protocol.<id>.title` key.
        expect(text).toContain('acme-wire-v1');
        expect(text).not.toContain('protocol.acme-wire-v1.title');
        // The bundled protocol still resolves its copy through the text owner.
        expect(text).toContain('settingsProviders.authoring.protocol.openai-responses.title');
    });

    it('keeps a key-based provider\'s endpoints behind their disclosure and says when Connect waits for approval', async () => {
        const onOpen = vi.fn();
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const screen = await renderScreen(
            <BuiltInProviderAuthoringView
                machineId={null}
                currentMachineName=""
                providerName="DeepSeek"
                icon={null}
                provenance="first_party"
                previewCredential={{ required: true }}
                endpointTemplates={[{ id: 'chat', protocol: 'openai-chat' }]}
                endpointValues={{}}
                secretSelected
                savedSecretSelectionEnabled
                preview={null}
                previewLoading={false}
                savePending
                pendingApproval={{ onOpen }}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
                onPickSecret={vi.fn()}
                onChooseCandidate={vi.fn()}
                onEndpointChange={vi.fn()}
                onSave={vi.fn()}
                onDiscard={vi.fn()}
            />,
        );

        // The provider supplies its addresses: overriding them is opened on demand.
        expect(screen.findByTestId('settings-provider-authoring-endpoint-chat')).toBeNull();
        await screen.pressByTestIdAsync('settings-provider-authoring-endpoints.header');
        expect(screen.findByTestId('settings-provider-authoring-endpoint-chat')).toBeTruthy();
        // A draft has no `⋯` menu.
        expect(screen.findByTestId('settings-provider-authoring-menu')).toBeNull();
        // Waiting for approval reads as waiting, with the way to the approval, not as a spinner.
        expect(screen.findByTestId('settings-provider-authoring-approval')).toBeTruthy();
        expect(screen.findAllByTestId('settings-provider-authoring-connect').some((node) => node.props.loading === true)).toBe(false);
        await screen.pressByTestIdAsync('settings-provider-authoring-approval.open');
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('exposes stable automation identities for external candidate review and connection', async () => {
        const onChooseCandidate = vi.fn();
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const screen = await renderScreen(
            <BuiltInProviderAuthoringView
                machineId="machine-a"
                currentMachineName="Mac"
                providerName="Provider"
                icon={null}
                provenance="external"
                previewCredential={{ required: false }}
                endpointTemplates={[]}
                endpointValues={{}}
                secretSelected={false}
            savedSecretSelectionEnabled
                preview={{
                    status: 'selection_required',
                    connectionId: ProviderConnectionIdSchema.parse('pc_candidate'),
                    contributionKey: 'acme.plugin/provider',
                    created: false,
                    credential: {
                        slotId: 'apiKey',
                        label: 'api_key',
                        required: false,
                    },
                    candidates: [{
                        candidateId: 'candidate-a',
                        scope: 'machine',
                        machineId: 'machine-a',
                        endpoints: [{
                            endpointTemplateId: 'responses',
                            protocol: 'openai-responses',
                            normalizedUrl: 'http://127.0.0.1:8317/v1',
                            locality: 'loopback',
                            scope: 'machine',
                        }],
                    }],
                }}
                previewLoading={false}
                savePending={false}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
                onPickSecret={vi.fn()}
                onChooseCandidate={onChooseCandidate}
                onEndpointChange={vi.fn()}
                onSave={vi.fn()}
                onDiscard={vi.fn()}
            />,
        );

        expect(screen.findByTestId('settings-provider-authoring-built-in')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-authoring-api-key')).toBeTruthy();
        // One step (PA1): a saved provider is simply on; there is no separate "enable after saving".
        expect(screen.findByTestId('settings-provider-authoring-enable-after-save')).toBeNull();
        expect(screen.findByTestId('settings-provider-authoring-connect')).toBeTruthy();
        await screen.pressByTestIdAsync('settings-provider-authoring-candidate:candidate-a');
        expect(onChooseCandidate).toHaveBeenCalledWith('candidate-a');
    });

    it('adds in one step: no destination review on the sheet, and says when no computer is needed (PA1)', async () => {
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const render = (scope: 'account' | 'machine') => renderScreen(
            <BuiltInProviderAuthoringView
                machineId="machine-a"
                currentMachineName="Mac"
                providerName="DeepSeek"
                icon={null}
                provenance="first_party"
                previewCredential={{ required: true }}
                endpointTemplates={[]}
                endpointValues={{}}
                secretSelected
                savedSecretSelectionEnabled
                preview={{
                    status: 'resolved',
                    connectionId: ProviderConnectionIdSchema.parse('pc_resolved'),
                    contributionKey: 'deepseek.plugin/provider',
                    created: false,
                    credential: { slotId: 'apiKey', label: 'api_key', required: true },
                    candidateId: 'discovery-candidate:v1:default',
                    scope,
                    machineId: scope === 'machine' ? 'machine-a' : null,
                    fingerprint: 'authoring-review:v1:resolved',
                    revision: 1,
                    endpoints: [{
                        endpointTemplateId: 'chat',
                        protocol: 'openai-chat',
                        normalizedUrl: scope === 'machine' ? 'http://127.0.0.1:11434/v1' : 'https://api.deepseek.com/v1',
                        locality: scope === 'machine' ? 'loopback' : 'public',
                        scope,
                    }],
                } as never}
                previewLoading={false}
                savePending={false}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
                onPickSecret={vi.fn()}
                onChooseCandidate={vi.fn()}
                onEndpointChange={vi.fn()}
                onSave={vi.fn()}
                onDiscard={vi.fn()}
            />,
        );
        const account = await render('account');
        expect(account.findByTestId('settings-provider-authoring-connect')!.props.disabled).toBe(false);
        expect(account.getTextContent()).toContain('settingsProvidersCollection.addAccountScopeHint');
        expect(account.findByTestId('settings-provider-authoring-destination-scope')).toBeNull();
        standardCleanup();
        // Where a computer's requests go is that computer's business, shown under "On this computer" on the
        // saved provider — never as a review step of the add sheet.
        const machine = await render('machine');
        expect(machine.findByTestId('settings-provider-authoring-connect')!.props.disabled).toBe(false);
        expect(machine.findByTestId('settings-provider-authoring-destination-scope')).toBeNull();
        expect(machine.findByTestId('settings-provider-authoring-resolved-endpoint:chat')).toBeNull();
        expect(machine.getTextContent()).not.toContain('settingsProvidersCollection.addAccountScopeHint');
    });
});
