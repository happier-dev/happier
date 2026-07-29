import { describe, expect, it } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema, type SessionProviderBindingMetadataV1 } from '@happier-dev/protocol';

import { presentSessionProviderBinding } from './presentation';

const binding: SessionProviderBindingMetadataV1 = {
    v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_work'), contributionKey: null, connectionRevision: 1,
    protocol: 'openai-responses', materialization: 'engineConfig',
    compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
    displaySnapshot: {
        providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom',
    },
};

describe('presentSessionProviderBinding', () => {
    it('uses the immutable launch snapshot and stays quiet while current', () => {
        expect(presentSessionProviderBinding({ binding, status: { status: 'current' } })).toEqual({
            launchLabel: 'Gateway · Work', banner: null,
        });
    });

    it('makes changed and unavailable launch bindings actionable without native fallback', () => {
        expect(presentSessionProviderBinding({
            binding, status: { status: 'changed', nextBindingSecurityFingerprint: 'binding-security:v1:b' },
            proposedDisplay: { providerName: 'Other', connectionName: 'Personal' },
        }).banner).toMatchObject({
            kind: 'changed', action: 'restart', providerName: 'Other', connectionName: 'Personal',
        });
        expect(presentSessionProviderBinding({
            binding,
            status: { status: 'connection_missing', error: { v: 1, code: 'provider_connection_not_found', retryable: false, action: 'choose_model' } },
        }).banner).toMatchObject({ kind: 'unavailable', action: 'choose-model' });
    });

    it('collapses an automatic default connection to the provider name', () => {
        expect(presentSessionProviderBinding({
            binding: {
                ...binding,
                displaySnapshot: {
                    providerName: 'OpenRouter', connectionName: 'OpenRouter', connectionRole: 'default', connectionDisplayNameMode: 'automatic',
                },
            },
            status: null,
        }).launchLabel).toBe('OpenRouter');
    });

    it('keeps an unavailable binding-status read visible and retryable', () => {
        expect(presentSessionProviderBinding({
            binding,
            status: null,
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_work', machineId: 'machine-a',
            }),
        }).banner).toMatchObject({
            kind: 'status-error',
            action: 'retry',
            providerName: 'Gateway',
            connectionName: 'Work',
        });
    });
});
