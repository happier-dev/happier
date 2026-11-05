import { describe, expect, it } from 'vitest';
import { ProviderConnectionsCatalogV1Schema, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { qualifyPluginAccountSecretBindingKey } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { listConnectSheetKeyBindingRefs } from './connectSheetKeyBindings';

const key = (id: string) => formatSharedSavedSecretRefV1(id);
const connection = (id: string, contributionKey: string) => ({ v: 1, id, source: { kind: 'contribution', contributionKey },
    role: 'named', displayName: id, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 });

describe('Connect sheet keys used by the same target', () => {
    it('finds the same Provider slot on another connection and Machine without admitting unrelated keys', () => {
        const providerConnections = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [connection('deepseek-main', 'provider/deepseek'), connection('deepseek-other', 'provider/deepseek'), connection('other', 'provider/other')],
            secretBindingsByConnectionId: {
                'deepseek-main': { account: { apiKey: key('key_main'), otherSlot: key('key_other_slot') } },
                'deepseek-other': { byMachineId: { 'another-machine': { apiKey: key('key_other_machine') } } },
                other: { account: { apiKey: key('key_unrelated') } },
            },
        });
        expect(listConnectSheetKeyBindingRefs({ target: { kind: 'provider', contributionKey: 'provider/deepseek', slot: 'apiKey' }, providerConnections }))
            .toEqual([key('key_main'), key('key_other_machine')]);
    });

    it('matches a service configuration field without using another service, method or field', () => {
        const service = { pluginId: 'cloud.auth', localId: 'cloud' };
        const row = { service, modeId: 'token', revision: 'one', values: {}, secretRefs: { token: key('key_target'), extra: key('key_extra') } };
        expect(listConnectSheetKeyBindingRefs({ target: { kind: 'service', service, modeId: 'token', fieldId: 'token' },
            connectedConfigurations: { v: 1, entries: [row, { ...row, modeId: 'other', secretRefs: { token: key('key_method') } },
                { ...row, service: { ...service, localId: 'another' }, secretRefs: { token: key('key_service') } }] } }))
            .toEqual([key('key_target')]);
    });

    it('reads the selected service field from its projection without re-admitting unrelated fields', () => {
        const service = { pluginId: 'cloud.auth', localId: 'cloud' };
        expect(listConnectSheetKeyBindingRefs({ target: { kind: 'service', service, modeId: 'token', fieldId: 'token' },
            connectedConfigurations: { v: 1, entries: [{ service, modeId: 'token', revision: 'one', values: {},
                secretRefs: { token: key('key_target'), unrelated: '' } }] } }))
            .toEqual([key('key_target')]);
    });

    it('does no configuration-value reads when projecting keys, and reflects a changed binding', () => {
        const service = { pluginId: 'cloud.auth', localId: 'cloud' };
        let valueReads = 0;
        const entry = { service, modeId: 'token', revision: 'one',
            get values() { valueReads += 1; return { endpoint: 'https://cloud.example' }; },
            secretRefs: { token: key('key_target') } };
        const input = { target: { kind: 'service' as const, service, modeId: 'token', fieldId: 'token' },
            connectedConfigurations: { v: 1 as const, entries: [entry] } };
        for (let render = 0; render < 3; render += 1) {
            expect(listConnectSheetKeyBindingRefs(input)).toEqual([key('key_target')]);
        }
        entry.secretRefs.token = key('key_changed');
        expect(listConnectSheetKeyBindingRefs(input)).toEqual([key('key_changed')]);
        expect(valueReads).toBe(0);
    });
    it('uses the host-owned Plugin binding identity without exposing material or unrelated plugin fields', () => {
        const target = { pluginId: 'plugin.example', localId: 'token' };
        const unrelated = { pluginId: 'plugin.example', localId: 'other' };
        const binding = (identity: typeof target, id: string) => ({ ...identity, custody: 'account', savedSecretId: key(id), createdForBinding: false });
        expect(listConnectSheetKeyBindingRefs({ target: { kind: 'plugin', ...target }, settings: {
            pluginSecretBindingsV1: {
                [qualifyPluginAccountSecretBindingKey(target)]: binding(target, 'key_target'),
                [qualifyPluginAccountSecretBindingKey(unrelated)]: binding(unrelated, 'key_unrelated'),
            },
        } })).toEqual([key('key_target')]);
    });

    it('finds the same Voice contribution slot across Machines without admitting another Voice target', () => {
        const contribution = { pluginId: 'voice.example', localId: 'speech' };
        const row = { contribution, credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { api_key: key('key_account') }, byMachineId: { other: { api_key: key('key_machine') } } } };
        expect(listConnectSheetKeyBindingRefs({ target: { kind: 'voice', contribution, slot: 'api_key' }, settings: {
            voiceSettingsV1: { credentialBindings: [row, { ...row, contribution: { ...contribution, localId: 'other' },
                credentialBindings: { account: { api_key: key('key_unrelated') } } }] },
        } })).toEqual([key('key_account'), key('key_machine')]);
    });

});
