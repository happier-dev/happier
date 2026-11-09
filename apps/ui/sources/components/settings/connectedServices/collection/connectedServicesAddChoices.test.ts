import { describe, expect, it } from 'vitest';
import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { buildConnectedServicesAddChoices, presentConnectedServicesAddMenuNotice } from './connectedServicesAddChoices';
import { t } from '@/text';
import { projectConnectedAccountDescriptorV1, ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { PLUGIN_MANIFEST as boat } from '@happier-dev/plugins-machine-boat/manifest';
import { PLUGIN_MANIFEST as crabbox } from '@happier-dev/plugins-machine-crabbox/manifest';
import { PLUGIN_MANIFEST as cua } from '@happier-dev/plugins-machine-cua/manifest';
import { PLUGIN_MANIFEST as digitalOcean } from '@happier-dev/plugins-machine-digitalocean/manifest';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { PLUGIN_MANIFEST as elevenlabs } from '../../../../../../../packages/plugins/elevenlabs/src/manifest';
import { PLUGIN_MANIFEST as xai } from '../../../../../../../packages/plugins/xai/src/manifest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';

describe('Connected services grouped Add choices', () => {
    const service = { pluginId: 'external.accounts', localId: 'sign-in' };
    function model(canAdd = true) {
        const result = buildConnectedServicesIndexModel({
            transport: 'legacy', entries: [{ serviceId: 'anthropic', service, legacyServiceId: 'anthropic',
                projectedTitle: 'Existing service', executable: canAdd, supportsOauth: false, connectCommand: 'happier connect anthropic' }],
            qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [{ serviceId: 'anthropic', profiles: [{ profileId: 'work', status: 'connected' }] }],
            defaultAccountByServiceKey: {}, resolveLabel: () => 'Existing service', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: canAdd ? null : 'Install the service', supportDetails: null }), loadingLabel: 'Loading',
        });
        // The menu consumes the already-admitted model, including a held disabled row.
        // Released legacy admission differs from the executable descriptor bit.
        return canAdd ? result : { ...result, sheets: result.sheets.map(sheet => ({ ...sheet, canAdd: false })) };
    }
    const gatewayPresentation = (key: string) => ({ title: `Gateway ${key}`, purpose: 'Draws on your accounts' });
    const gatewayAdmission = { canAdd: true, reason: null };
    it('offers Secret first and declaration-owned Voice key drafts through the existing key sheet', () => {
        const voiceProviders = [elevenlabs, xai].flatMap(manifest =>
            (manifest.contributes.voiceProviders ?? []).map(raw => ({ pluginId: manifest.id,
                declaration: VoiceProviderContributionSchema.parse(raw) })));
        const choices = buildConnectedServicesAddChoices({ model: { sheets: [], connectable: [] },
            gateways: { status: 'unavailable', choices: [] }, gatewayAdmission, gatewayPresentation,
            includeSecret: true, voiceProviders, localize: text => typeof text === 'string' ? text : text.fallback });
        expect(choices[0]).toMatchObject({ kind: 'key', key: 'secret', service: { kind: 'key' } });
        const voice = choices.filter(choice => choice.category === 'voice');
        expect(voice).toHaveLength(2);
        expect(voice).toEqual(expect.arrayContaining(voiceProviders.map(({ pluginId, declaration }) => expect.objectContaining({
            kind: 'key', service: { kind: 'key', keyKind: 'apiKey', suggestedName: declaration.credentials!.slot.title },
            bindingTarget: { kind: 'voice', contribution: { pluginId, localId: declaration.id }, slot: declaration.credentials!.slot.id },
        }))));
    });
    it('projects authored cloud-machine accounts into the cloud menu through the real catalog', () => {
        const entries = [boat, crabbox, cua, digitalOcean].flatMap(manifest =>
            (manifest.contributes.connectedAccountDescriptors ?? []).map(rawDescriptor => {
                const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse(rawDescriptor);
                const projectedDescriptor = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
                    descriptor, serviceId: descriptor.id, pluginId: manifest.id, provenance: 'first_party',
                    sourceKind: 'bundled', availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
                }));
                return { serviceId: descriptor.id, service: { pluginId: manifest.id, localId: descriptor.id },
                    projectedDescriptor, projectedTitle: projectedDescriptor.title,
                    executable: true, supportsOauth: false, connectCommand: '' };
            }));
        const index = buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries, qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
            defaultAccountByServiceKey: {}, resolveLabel: entry => typeof entry?.projectedTitle === 'string'
                ? entry.projectedTitle : entry?.projectedTitle?.fallback ?? '',
            resolveFallbackEntry: () => null, presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
        });
        const choices = buildConnectedServicesAddChoices({ model: index, gateways: { status: 'unavailable', choices: [] },
            gatewayAdmission, gatewayPresentation });
        expect(choices).toHaveLength(5);
        expect(choices.every(choice => choice.kind === 'account' && choice.category === 'cloud-machines' && !choice.disabled)).toBe(true);
        expect(choices.map(choice => choice.serviceKey).sort()).toEqual(entries.map(entry => `${entry.service.pluginId}/${entry.service.localId}`).sort());
    });
    it('says once why services cannot be added when they only wait for a machine, and never for a row with its own reason', () => {
        const quiet = buildConnectedServicesIndexModel({
            transport: 'legacy', entries: [{ serviceId: 'anthropic', service, legacyServiceId: 'anthropic',
                projectedTitle: 'Existing service', executable: false, supportsOauth: false, connectCommand: 'happier connect anthropic' }],
            qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [{ serviceId: 'anthropic', profiles: [{ profileId: 'work', status: 'connected' }] }],
            defaultAccountByServiceKey: {}, resolveLabel: () => 'Existing service', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
        });
        const waiting = { ...quiet, sheets: quiet.sheets.map(sheet => ({ ...sheet, canAdd: false })) };
        const waitingChoices = buildConnectedServicesAddChoices({ model: waiting, gateways: { status: 'unavailable', choices: [] }, gatewayAdmission, gatewayPresentation });
        expect(waitingChoices[0]).toMatchObject({ disabled: true, reason: null });
        expect(presentConnectedServicesAddMenuNotice(waitingChoices)).toBe(t('connectedServicesCollection.menuWaitingForMachine'));
        const ownReason = buildConnectedServicesAddChoices({ model: model(false), gateways: { status: 'unavailable', choices: [] }, gatewayAdmission, gatewayPresentation });
        expect(presentConnectedServicesAddMenuNotice(ownReason)).toBeNull();
        const open = buildConnectedServicesAddChoices({ model: model(), gateways: { status: 'unavailable', choices: [] }, gatewayAdmission, gatewayPresentation });
        expect(presentConnectedServicesAddMenuNotice(open)).toBeNull();
    });
    it('opens an account draft for an existing service without creating an account', () => {
        const input = model();
        const before = JSON.stringify(input);
        const choices = buildConnectedServicesAddChoices({ model: input, gateways: { status: 'unavailable', choices: [] }, gatewayAdmission, gatewayPresentation });
        expect(choices).toHaveLength(1);
        expect(choices[0]).toMatchObject({ kind: 'account', disabled: false, addedCount: 1 });
        expect(choices[0]).toMatchObject({ service, href: null });
        expect(JSON.stringify(input)).toBe(before);
    });
    it('retains unsupported service prerequisites without turning retained existence into admission', () => {
        const choices = buildConnectedServicesAddChoices({ model: model(false), gateways: { status: 'unavailable', choices: [] }, gatewayAdmission, gatewayPresentation });
        expect(choices).toHaveLength(1);
        expect(choices[0]).toMatchObject({ disabled: true, href: null, reason: 'Install the service' });
    });
    it('keeps every explicit gateway contribution choice instead of picking the first', () => {
        const choices = buildConnectedServicesAddChoices({ model: { sheets: [], connectable: [] },
            gateways: { status: 'choice_required', choices: [
                { contributionKey: 'external.one/gateway', purposes: [] }, { contributionKey: 'external.two/gateway', purposes: [] },
            ] }, gatewayAdmission, gatewayPresentation });
        expect(choices.map(choice => choice.contributionKey)).toEqual(['external.one/gateway', 'external.two/gateway']);
        expect(choices.map(choice => {
            if (typeof choice.href !== 'string') throw new Error('Expected gateway route');
            return new URL(choice.href, 'http://local').searchParams.get('contributionKey');
        }))
            .toEqual(['external.one/gateway', 'external.two/gateway']);
    });
    it('does not grant creation from a declaration alone or invent a known zero added count', () => {
        const input = { model: { sheets: [], connectable: [] }, gateways: { status: 'selected' as const,
            contribution: { contributionKey: 'external.one/gateway', purposes: [] } }, gatewayPresentation };
        expect(buildConnectedServicesAddChoices({ ...input, gatewayAdmission: { canAdd: false, reason: 'Catalog unavailable' } })[0])
            .toMatchObject({ disabled: true, href: null, reason: 'Catalog unavailable', addedCount: null });
        expect(buildConnectedServicesAddChoices({ ...input, gatewayAdmission: { canAdd: true, reason: null,
            addedCountByContributionKey: { 'external.one/gateway': 2 } } })[0]).toMatchObject({ disabled: false, addedCount: 2 });
    });
});
