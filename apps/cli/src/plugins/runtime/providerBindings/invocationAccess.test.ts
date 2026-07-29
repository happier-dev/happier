import { describe, expect, it } from 'vitest';

import { composeProviderBindingProcessAccess } from './invocationAccess';

const processAccess = {
    id: 'agent-process',
    capability: 'process' as const,
    reason: 'Run the declared Agent executable',
    scope: {
        executables: [{ kind: 'systemTool' as const, id: 'agent-cli' }],
        envKeys: ['STATIC_ALLOWED'],
    },
};

const providerRequirements = {
    acceptsProtocols: ['openai-responses'],
    required: { streaming: true, toolRoundTrips: true },
    credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
    authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
    },
    materialization: 'engineConfig',
    applyPolicy: 'restart_session',
    supportsFreeformModelIds: true,
};

describe('composeProviderBindingProcessAccess', () => {
    it('authorizes only active materialized Provider-owned keys on existing process access', () => {
        const requests = composeProviderBindingProcessAccess({
            requests: [processAccess],
            providerRequirements,
            providerBindingActive: true,
            environment: {
                HAPPIER_CODEX_PROVIDER_API_KEY: 'scoped-secret',
                HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1: 'host-only-carrier',
                UNRELATED_ENV: 'not-authorized',
            },
        });

        expect(requests).toEqual([{
            ...processAccess,
            scope: {
                ...processAccess.scope,
                envKeys: ['STATIC_ALLOWED', 'HAPPIER_CODEX_PROVIDER_API_KEY'],
            },
        }]);
    });

    it('does not widen process access for a native session', () => {
        const requests = Object.freeze([processAccess]);
        expect(composeProviderBindingProcessAccess({
            requests,
            providerRequirements,
            providerBindingActive: false,
            environment: { HAPPIER_CODEX_PROVIDER_API_KEY: 'ambient-secret' },
        })).toBe(requests);
    });
});
