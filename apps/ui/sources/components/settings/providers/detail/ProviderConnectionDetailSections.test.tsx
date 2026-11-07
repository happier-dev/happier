import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { Item } from '@/components/ui/lists/Item';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Item as PublicItem, TextField as PublicTextField } from '@happier-dev/plugin-ui';
import { DaemonProviderConnectionEndpointViewV1Schema } from '@happier-dev/protocol/rpc/providers';
import { resolveEffectiveProviderEndpointV1 } from '@happier-dev/protocol/providers/connections/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

describe('ProviderCompatibilitySection', () => {
    afterEach(standardCleanup);

    it('opens the shared model review for the experimental Agent without confirming on arrival', async () => {
        const { ProviderCompatibilitySection } = await import('./ProviderConnectionDetailSections');
        const review = vi.fn();
        const screen = await renderScreen(<ProviderCompatibilitySection onReview={review} summaries={[
            { agentTargetKey: 'agent:happier.agent.opencode/opencode', agentName: 'OpenCode', status: 'experimental', reasons: ['compatibility_evidence_missing'] },
        ]} />);
        expect(review).not.toHaveBeenCalled();
        const row = screen.findAllByType(Item).find(item => item.props.title === 'OpenCode');
        expect(row?.props.onPress).toBeTypeOf('function');
        await act(async () => { await row?.props.onPress(); });
        expect(review).toHaveBeenCalledWith('agent:happier.agent.opencode/opencode');
    });

    it('lists the agents that can use a connection and folds the rest into one row that names them', async () => {
        const { ProviderCompatibilitySection } = await import('./ProviderConnectionDetailSections');
        const screen = await renderScreen(<ProviderCompatibilitySection summaries={[
            { agentTargetKey: 'backend:codex', agentName: 'Codex', status: 'experimental', reasons: ['compatibility_evidence_missing'] },
            { agentTargetKey: 'backend:claude', agentName: 'Claude', status: 'verified', reasons: [] },
            { agentTargetKey: 'backend:auggie', agentName: 'Auggie', status: 'incompatible', reasons: ['no_compatible_protocol'] },
            { agentTargetKey: 'backend:kilo', agentName: 'Kilo', status: 'incompatible', reasons: [] },
        ] as never} />);
        const items = screen.findAllByType(Item);
        // Usable agents first, each pill finished by its reason, never by the pill's own sentence again.
        expect(items.map((item) => item.props.title).slice(0, 2)).toEqual(['Claude', 'Codex']);
        expect(items.find((item) => item.props.title === 'Codex')?.props.subtitle)
            .toBe('settingsProviders.compatibility.reasons.evidenceMissing');
        expect(items.find((item) => item.props.title === 'Claude')?.props.subtitle).toBeUndefined();
        // The agents that cannot use it: one quiet row, its count alone, opened on demand; the usable agents lead.
        expect(items.map((item) => item.props.title)).not.toContain('Auggie');
        const incompatible = items.find((item) => item.props.title === 'settingsProviders.compatibility.incompatible');
        expect(incompatible?.props.detail).toBe('2');
        expect(incompatible?.props.subtitle).toBeUndefined();
    });

    it('says a reason every usable agent shares once, in the section, not under each agent', async () => {
        const { ProviderCompatibilitySection } = await import('./ProviderConnectionDetailSections');
        const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
        const shared = 'model_required_for_capability_resolution';
        const screen = await renderScreen(<ProviderCompatibilitySection summaries={[
            { agentTargetKey: 'backend:codex', agentName: 'Codex', status: 'experimental', reasons: [shared] },
            { agentTargetKey: 'backend:opencode', agentName: 'OpenCode', status: 'experimental', reasons: [shared, 'compatibility_evidence_missing'] },
            { agentTargetKey: 'backend:pi', agentName: 'Pi', status: 'experimental', reasons: [shared] },
        ] as never} />);
        const rendered = screen.getTextContent();
        const sharedKey = 'settingsProviders.compatibility.reasons.modelEvidenceRequired';
        expect(rendered.split(sharedKey)).toHaveLength(2);
        const group = screen.findAllByType(ItemGroup)[0];
        expect(String(group?.props.description)).toContain(sharedKey);
        const items = screen.findAllByType(Item);
        // A row keeps only what sets it apart; nothing left means the pill and the section say it all.
        expect(items.find((item) => item.props.title === 'OpenCode')?.props.subtitle).toBe('settingsProviders.compatibility.reasons.evidenceMissing');
        expect(items.find((item) => item.props.title === 'Codex')?.props.subtitle).toBeUndefined();
    });

    it('keeps an unset required endpoint editable without inventing a destination', async () => {
        const { ProviderEndpointOverridesSection } = await import('./ProviderConnectionDetailSections');
        const endpoint = DaemonProviderConnectionEndpointViewV1Schema.parse({
            endpointTemplateId: 'messages', protocol: 'anthropic', baseUrl: null,
            requiresEndpointOverride: true, effectiveSource: 'template',
        });
        const screen = await renderScreen(<ProviderEndpointOverridesSection
            endpoints={[endpoint]} machineSelected onSetOverride={() => {}} onSetHeaders={() => {}}
            localizeText={(value) => String(value)}
        />);
        expect(screen.findAllByType(FieldValueItem).map(field => field.props.value)).toEqual(['', '']);
    });
    it('edits an endpoint\'s public headers at the chosen layer and resets that layer to what it inherits', async () => {
        const { ProviderEndpointOverridesSection } = await import('./ProviderConnectionDetailSections');
        const endpoint = DaemonProviderConnectionEndpointViewV1Schema.parse({
            endpointTemplateId: 'messages', protocol: 'anthropic', baseUrl: 'https://gateway.example/v1/a/g/anthropic',
            effectiveSource: 'accountOverride', accountOverrideBaseUrl: 'https://gateway.example/v1/a/g/anthropic',
            publicHeaders: { 'x-collect-log': 'true', 'x-skip-cache': 'true' },
            defaultPublicHeaders: { 'x-collect-log': 'false', 'x-skip-cache': 'true' },
            accountOverridePublicHeaders: { 'x-collect-log': 'true' },
            machineOverridePublicHeaders: { 'x-skip-cache': 'false' },
            publicHeaderSources: { 'x-collect-log': 'accountOverride', 'x-skip-cache': 'machineOverride' },
            publicHeaderHints: { 'x-collect-log': 'False keeps logs off.' },
        });
        const onSetHeaders = vi.fn();
        const screen = await renderScreen(<ProviderEndpointOverridesSection
            endpoints={[endpoint]} machineSelected onSetOverride={() => {}} onSetHeaders={onSetHeaders}
            localizeText={(value) => String(value)}
        />);
        // The shared public editor: each header is a public row whose field carries the value.
        const field = (id: string) => screen.findAllByType(PublicTextField).find((row) => row.props.testID === id);
        const subtitle = (id: string) => screen.findAllByType(PublicItem).find((row) => row.props.testID === `${id}.row`)?.props.subtitle;
        const accountLog = field('provider-connection-endpoint.messages.account.header.x-collect-log');
        // The layer's own value, labelled as set there, with the plugin's consequence beside it.
        expect(accountLog?.props.value).toBe('true');
        expect(subtitle('provider-connection-endpoint.messages.account.header.x-collect-log')).toContain('settingsProvidersCollection.headersSetAccount');
        expect(subtitle('provider-connection-endpoint.messages.account.header.x-collect-log')).toContain('False keeps logs off.');
        // An inherited value is read from the lower layer and says where it comes from.
        expect(subtitle('provider-connection-endpoint.messages.account.header.x-skip-cache'))
            .toContain('settingsProvidersCollection.headersFromProvider');
        const machineLog = field('provider-connection-endpoint.messages.machine.header.x-collect-log');
        expect(machineLog?.props.value).toBe('true');
        expect(subtitle('provider-connection-endpoint.messages.machine.header.x-collect-log')).toContain('settingsProvidersCollection.headersFromAccount');

        // Typing the inherited value back removes only that entry from the layer (no URL in the patch).
        await act(async () => { accountLog?.props.onCommit('false'); });
        expect(onSetHeaders).toHaveBeenLastCalledWith({ endpointTemplateId: 'messages', scope: 'account', publicHeaders: null });
        await act(async () => { machineLog?.props.onCommit('false'); });
        expect(onSetHeaders).toHaveBeenLastCalledWith({ endpointTemplateId: 'messages', scope: 'machine',
            publicHeaders: { 'x-skip-cache': 'false', 'x-collect-log': 'false' } });

        const reset = screen.findAllByType(PublicItem).find((row) => row.props.testID === 'provider-connection-endpoint.messages.machine.headers.reset');
        await act(async () => { reset?.props.onPress(); });
        expect(onSetHeaders).toHaveBeenLastCalledWith({ endpointTemplateId: 'messages', scope: 'machine', publicHeaders: null });
    });

    it('asks for a required header the provider leaves unset and says an unset endpoint blocks only its own agents', async () => {
        const { ProviderEndpointOverridesSection } = await import('./ProviderConnectionDetailSections');
        const endpoint = DaemonProviderConnectionEndpointViewV1Schema.parse({
            endpointTemplateId: 'chat', protocol: 'openai-chat', baseUrl: null,
            requiresEndpointOverride: true, effectiveSource: 'template', requiredPublicHeaders: ['x-gateway-id'],
        });
        const onSetHeaders = vi.fn();
        const screen = await renderScreen(<ProviderEndpointOverridesSection
            endpoints={[endpoint]} machineSelected={false} onSetOverride={() => {}} onSetHeaders={onSetHeaders}
            localizeText={(value) => String(value)}
        />);
        const fields = screen.findAllByType(FieldValueItem);
        expect(fields.find((row) => row.props.fieldTestID === 'provider-connection-endpoint.chat.account')?.props.subtitle)
            .toBe('settingsProvidersCollection.endpointNotSet');
        const gateway = screen.findAllByType(PublicTextField).find((row) => row.props.testID === 'provider-connection-endpoint.chat.account.header.x-gateway-id');
        expect(gateway?.props.value).toBe('');
        await act(async () => { gateway?.props.onCommit('my-gateway'); });
        expect(onSetHeaders).toHaveBeenLastCalledWith({ endpointTemplateId: 'chat', scope: 'account', publicHeaders: { 'x-gateway-id': 'my-gateway' } });
    });

    // The view the daemon sends is the protocol owner's projection of one template for one chosen machine.
    const projectEndpoint = (
        template: Parameters<typeof resolveEffectiveProviderEndpointV1>[0]['template'],
        connection: Parameters<typeof resolveEffectiveProviderEndpointV1>[0]['connection'],
    ) => {
        const { ready: _ready, reason: _reason, ...effective } = resolveEffectiveProviderEndpointV1({ connection, template, machineId: 'machine-1' });
        return DaemonProviderConnectionEndpointViewV1Schema.parse({
            endpointTemplateId: template.id, protocol: template.protocol,
            requiresEndpointOverride: template.requiresEndpointOverride, ...effective,
        });
    };

    it('keeps an address set only for the chosen computer in the computer layer and the every-computer address unset', async () => {
        const { ProviderEndpointOverridesSection } = await import('./ProviderConnectionDetailSections');
        const url = 'https://gateway.example/v1/a/g/anthropic';
        const endpoint = projectEndpoint(
            { id: 'messages', protocol: 'anthropic', requiresEndpointOverride: true },
            { endpointOverridesByMachineId: { 'machine-1': [{ endpointTemplateId: 'messages', baseUrl: url }] } },
        );
        const screen = await renderScreen(<ProviderEndpointOverridesSection
            endpoints={[endpoint]} machineSelected onSetOverride={() => {}} onSetHeaders={() => {}}
            localizeText={(value) => String(value)}
        />);
        const field = (id: string) => screen.findAllByType(FieldValueItem).find((row) => row.props.fieldTestID === id);
        // No other computer inherits it: the every-computer field stays empty and still says it is not set.
        expect(field('provider-connection-endpoint.messages.account')?.props.value).toBe('');
        expect(field('provider-connection-endpoint.messages.account')?.props.subtitle).toBe('settingsProvidersCollection.endpointNotSet');
        expect(field('provider-connection-endpoint.messages.machine')?.props.value).toBe(url);
        const resets = screen.findAllByType(Item).filter((row) => row.props.title === 'settingsProviders.detail.resetEndpoint');
        expect(resets.map((row) => row.props.accessibilityLabel)).toEqual([expect.stringContaining('settingsProviders.detail.endpointMachine')]);
        // Nothing above the computer layer supplies an address, so its reset clears rather than falls back.
        expect(resets.map((row) => row.props.subtitle)).toEqual(['settingsProviders.detail.clearEndpoint']);
    });

    it('says a reset falls back to the provider only when the provider supplies an address', async () => {
        const { ProviderEndpointOverridesSection } = await import('./ProviderConnectionDetailSections');
        const override = { endpointOverrides: [{ endpointTemplateId: 'messages', baseUrl: 'https://gateway.example/v1/a/g/anthropic' }] };
        const resetSubtitle = async (template: Parameters<typeof projectEndpoint>[0]) => {
            const screen = await renderScreen(<ProviderEndpointOverridesSection
                endpoints={[projectEndpoint(template, override)]} machineSelected={false} onSetOverride={() => {}}
                onSetHeaders={() => {}} localizeText={(value) => String(value)}
            />);
            return screen.findAllByType(Item).find((row) => row.props.title === 'settingsProviders.detail.resetEndpoint')?.props.subtitle;
        };
        expect(await resetSubtitle({ id: 'messages', protocol: 'anthropic', baseUrl: 'https://api.example.com' }))
            .toBe('settingsProviders.detail.resetDefaultEndpoint');
        expect(await resetSubtitle({ id: 'messages', protocol: 'anthropic', requiresEndpointOverride: true }))
            .toBe('settingsProviders.detail.clearEndpoint');
    });
});
