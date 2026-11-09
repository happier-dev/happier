import { describe, expect, it } from 'vitest';

import type { PluginConfigurationSettingFieldV2 } from '@happier-dev/protocol/plugins/contributions/settings';

import {
    buildConnectedAccountConfigurationSubmission,
    createConnectedAccountConfigurationDraft,
    resolveConnectedAccountConfigurationControl,
} from './connectedAccountConfigurationDraft';

const fields = [
    {
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string', minLength: 1 },
        required: true,
        presentation: { control: 'text' },
    },
    {
        id: 'enabled',
        title: 'Enabled',
        schema: { type: 'boolean' },
        default: true,
    },
    {
        id: 'region',
        title: 'Region',
        schema: { type: 'string', enum: ['eu', 'us'] },
        presentation: {
            options: [
                { value: 'eu', title: 'Europe' },
                { value: 'us', title: 'United States' },
            ],
        },
    },
    {
        id: 'retries',
        title: 'Retries',
        schema: { type: 'integer' },
        presentation: { control: 'number' },
    },
    {
        id: 'metadata',
        title: 'Metadata',
        schema: { type: 'object' },
    },
    {
        id: 'clientSecret',
        title: 'Client secret',
        schema: { type: 'string', minLength: 1 },
        secret: true,
        required: true,
    },
] satisfies PluginConfigurationSettingFieldV2[];

describe('connectedAccountConfigurationDraft', () => {
    it('stages reference replacement and clearing independently of raw secret values', () => {
        const secretFields = fields.filter(field => field.secret);
        const draft = createConnectedAccountConfigurationDraft({ fields: secretFields, values: {} });
        const selection = { ref: 'happier:shared-secret:v1:replacement', resourceRevision: 3 };
        expect(buildConnectedAccountConfigurationSubmission({ fields: secretFields, draft,
            configuredSecretFieldIds: ['clientSecret'], secretRefs: { clientSecret: 'existing' }, selectedSecrets: {},
        })).toEqual({ ok: true, values: {}, secretValues: {}, selectedSecrets: {} });
        expect(buildConnectedAccountConfigurationSubmission({ fields: secretFields, draft,
            configuredSecretFieldIds: [], secretRefs: {}, selectedSecrets: { clientSecret: selection },
        })).toEqual({ ok: true, values: {}, secretValues: {}, selectedSecrets: { clientSecret: selection } });
        expect(buildConnectedAccountConfigurationSubmission({ fields: secretFields, draft,
            configuredSecretFieldIds: ['clientSecret'], secretRefs: { clientSecret: 'existing' }, selectedSecrets: { clientSecret: null },
        })).toEqual({ ok: false, missingFieldIds: ['clientSecret'], invalidFieldIds: [] });
        expect(buildConnectedAccountConfigurationSubmission({ fields: secretFields.map(field => ({ ...field, required: false })), draft,
            configuredSecretFieldIds: ['clientSecret'], secretRefs: { clientSecret: 'existing' }, selectedSecrets: { clientSecret: null },
        })).toEqual({ ok: true, values: {}, secretValues: {}, selectedSecrets: { clientSecret: null } });
    });

    it('derives every generic control from descriptor presentation and schema facts', () => {
        expect(fields.map(resolveConnectedAccountConfigurationControl)).toEqual([
            'text',
            'switch',
            'select',
            'number',
            'json',
            'text',
        ]);
    });

    it('keeps redacted secret state out of UI drafts and emits only explicit secret replacement', () => {
        const draft = createConnectedAccountConfigurationDraft({
            fields,
            values: {
                endpoint: 'https://api.example.com',
                enabled: false,
                region: 'eu',
                retries: 2,
                metadata: { audience: 'work' },
            },
        });

        expect(draft).toEqual({
            endpoint: 'https://api.example.com',
            enabled: false,
            region: 'eu',
            retries: '2',
            metadata: '{\n  "audience": "work"\n}',
            clientSecret: '',
        });

        expect(buildConnectedAccountConfigurationSubmission({
            fields,
            draft,
            configuredSecretFieldIds: ['clientSecret'],
        })).toEqual({
            ok: true,
            values: {
                endpoint: 'https://api.example.com',
                enabled: false,
                region: 'eu',
                retries: 2,
                metadata: { audience: 'work' },
            },
            secretValues: {},
        });

        expect(buildConnectedAccountConfigurationSubmission({
            fields,
            draft: { ...draft, clientSecret: 'replacement' },
            configuredSecretFieldIds: ['clientSecret'],
        })).toEqual({
            ok: true,
            values: {
                endpoint: 'https://api.example.com',
                enabled: false,
                region: 'eu',
                retries: 2,
                metadata: { audience: 'work' },
            },
            secretValues: { clientSecret: 'replacement' },
        });
    });

    it('returns stable missing and invalid field ids without mutating canonical configuration state', () => {
        const draft = createConnectedAccountConfigurationDraft({
            fields,
            values: {},
        });

        expect(buildConnectedAccountConfigurationSubmission({
            fields,
            draft: {
                ...draft,
                endpoint: '',
                retries: 'not-a-number',
                metadata: '{',
            },
            configuredSecretFieldIds: [],
        })).toEqual({
            ok: false,
            missingFieldIds: ['clientSecret', 'endpoint'],
            invalidFieldIds: ['metadata', 'retries'],
        });
    });
});
