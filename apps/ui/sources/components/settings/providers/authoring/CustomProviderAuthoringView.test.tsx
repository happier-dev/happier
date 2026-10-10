import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { buildCustomProviderTemplate, createCustomProviderDraft, type CustomProviderDraft } from '@/providers/authoring/state';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { CustomProviderAuthoringView } from './CustomProviderAuthoringView';

installSettingsViewCommonModuleMocks({ storage: importOriginal => importOriginal() });

function Editor(props: Readonly<{
    initial: CustomProviderDraft;
    onSave: (draft: CustomProviderDraft) => void;
    onDiscard?: () => void;
}>) {
    const [draft, setDraft] = React.useState(props.initial);
    const fieldRef = React.useRef(null);
    return <CustomProviderAuthoringView model={{
        machineId: 'machine-a', currentMachineName: 'Mac', draft,
        presets: [], presetOpen: false, credentialStyles: [], credentialOpen: false,
        invalidField: null, localEndpoint: null, enableAfterSaving: false,
        draftRequiresApiKey: draft.advanced ? draft.endpoints.some(endpoint => endpoint.enabled && endpoint.requiresApiKey) : draft.requiresApiKey,
        secretSelected: false, savedSecretSelectionEnabled: true,
        manualModelsError: null, draftHasProbe: true, probeState: 'idle', savePending: false,
        error: null, probeError: null, secondaryTextColor: '#777',
        nameFieldRef: fieldRef, baseUrlFieldRef: fieldRef, manualModelsFieldRef: fieldRef,
    }} actions={{
        onPresetOpenChange: () => {}, onCredentialOpenChange: () => {}, onPresetSelect: () => {},
        onCredentialStyleSelect: () => {}, onDraftChange: setDraft,
        onNameChange: name => setDraft(current => ({ ...current, name })),
        onBaseUrlChange: baseUrl => setDraft(current => ({ ...current, baseUrl })),
        onManualModelsChange: manualModelsText => setDraft(current => ({ ...current, manualModelsText })),
        onEnableAfterSavingChange: () => {}, onPickSecret: () => {}, onReviewConnection: () => {},
        onTest: () => {}, onSave: () => props.onSave(draft), onDiscard: props.onDiscard ?? (() => {}),
    }} />;
}

describe('custom provider authoring', () => {
    afterEach(standardCleanup);

    it('preserves simple endpoint, credential choice and catalog path when Advanced is enabled and saved', async () => {
        const save = vi.fn((draft: CustomProviderDraft) => buildCustomProviderTemplate(draft));
        const screen = await renderScreen(<Editor initial={{
            ...createCustomProviderDraft('openai-chat'), name: 'Gateway',
            baseUrl: 'https://gateway.example.test/v1', requiresApiKey: false, modelsPath: '/our-models',
        }} onSave={save} />);
        await act(async () => screen.findByTestId('settings-provider-authoring-advanced')!.props.onValueChange(true));
        await screen.pressByTestIdAsync('settings-provider-authoring-save');
        expect(save).toHaveReturnedWith(expect.objectContaining({
            endpointTemplates: [expect.objectContaining({ protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1' })],
            catalog: expect.objectContaining({ probes: [expect.objectContaining({ path: '/our-models' })] }),
        }));
        expect(save.mock.results[0]?.value.credential).toBeUndefined();
    });

    it('keeps Save and Cancel directly available in phone navigation', async () => {
        const save = vi.fn();
        const discard = vi.fn();
        const screen = await renderScreen(<DestinationInstanceHost tabId="provider-draft"
            ref={{ kind: 'settings', params: {} }} pathname="/settings/providers/new" focused visible phone
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Editor initial={{ ...createCustomProviderDraft('openai-chat'), name: 'Gateway' }} onSave={save} onDiscard={discard} />
        </DestinationInstanceHost>);
        expect(screen.findHostByTestId('settings-provider-authoring-save')).not.toBeNull();
        expect(screen.findHostByTestId('settings-provider-authoring-cancel')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-provider-authoring-save');
        await screen.pressByTestIdAsync('settings-provider-authoring-cancel');
        expect(save).toHaveBeenCalledOnce();
        expect(discard).toHaveBeenCalledOnce();
    });
});
