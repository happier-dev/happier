import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import {
    findTestInstanceByTypeContainingText,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();

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

    it('politely announces destination resolution without making static info rows live', async () => {
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const screen = await renderScreen(
            <BuiltInProviderAuthoringView
                targetMachines={[]}
                machineId="machine-a"
                currentMachineName="Mac"
                providerName="Provider"
            provenance="external"
            previewCredential={null}
            endpointTemplates={[]}
            endpointValues={{}}
            secretSelected={false}
                preview={null}
                previewLoading
                enableAfterSaving={false}
                savePending={false}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
                onSelectMachine={vi.fn()}
            onPickSecret={vi.fn()}
            onChooseCandidate={vi.fn()}
            onEndpointChange={vi.fn()}
            onEnableAfterSavingChange={vi.fn()}
                onSave={vi.fn()}
            />,
        );

        const resolvingStatus = screen.findByTestId('settings-provider-authoring-destination-status');
        expect(resolvingStatus?.props.accessibilityRole).toBe('text');
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
                targetMachines={[]}
                machineId="machine-a"
                currentMachineName="Mac"
                providerName="Acme"
                provenance="external"
                previewCredential={null}
                endpointTemplates={[
                    { id: 'acme', protocol: 'acme-wire-v1' },
                    { id: 'responses', protocol: 'openai-responses' },
                ]}
                endpointValues={{ acme: 'https://api.acme.example/v1' }}
                secretSelected={false}
                preview={null}
                previewLoading={false}
                enableAfterSaving={false}
                savePending={false}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
                onSelectMachine={vi.fn()}
                onPickSecret={vi.fn()}
                onChooseCandidate={vi.fn()}
                onEndpointChange={vi.fn()}
                onEnableAfterSavingChange={vi.fn()}
                onSave={vi.fn()}
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

    it('exposes stable automation identities for external candidate review and connection', async () => {
        const onChooseCandidate = vi.fn();
        const { BuiltInProviderAuthoringView } = await import('./BuiltInProviderAuthoringView');
        const screen = await renderScreen(
            <BuiltInProviderAuthoringView
                targetMachines={[]}
                machineId="machine-a"
                currentMachineName="Mac"
                providerName="Provider"
                provenance="external"
                previewCredential={{ required: false }}
                endpointTemplates={[]}
                endpointValues={{}}
                secretSelected={false}
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
                enableAfterSaving={false}
                savePending={false}
                error={null}
                secondaryTextColor="#777"
                warningColor="#b70"
                onSelectMachine={vi.fn()}
                onPickSecret={vi.fn()}
                onChooseCandidate={onChooseCandidate}
                onEndpointChange={vi.fn()}
                onEnableAfterSavingChange={vi.fn()}
                onSave={vi.fn()}
            />,
        );

        expect(screen.findByTestId('settings-provider-authoring-built-in')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-authoring-api-key')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-authoring-enable-after-save')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-authoring-connect')).toBeTruthy();
        await screen.pressByTestIdAsync('settings-provider-authoring-candidate:candidate-a');
        expect(onChooseCandidate).toHaveBeenCalledWith('candidate-a');
    });
});
