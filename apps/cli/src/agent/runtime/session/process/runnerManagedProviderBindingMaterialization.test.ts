import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
    createPluginInvocationSecretRedactor,
} from '@/plugins/runtime/invocation/services/logger';

import {
    createRunnerManagedProviderBindingLaunchEnvironmentTransformer,
} from './runnerManagedProviderBindingMaterialization';

const placeholder = 'happier_runner_placeholder_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
const credential = 'runner-owned-secret';

describe('runner managed Provider binding materialization', () => {
    it('keeps the placeholder public and deterministically substitutes only an exact declared child env slot', () => {
        const transformer =
            createRunnerManagedProviderBindingLaunchEnvironmentTransformer({
                placeholder,
                credential,
                renderedPlaceholder: `Bearer ${placeholder}`,
                renderedCredential: `Bearer ${credential}`,
                isCurrent: () => true,
                materialization: {
                    v: 1,
                    kind: 'spawnEnv',
                    env: [{
                        name: 'OPENCODE_CONFIG_CONTENT',
                        value: placeholder,
                        source: 'provider',
                    }],
                    additionalRedactionValues: [`Bearer ${placeholder}`],
                },
            });
        expect(JSON.stringify(transformer.materialization))
            .toContain(placeholder);
        expect(JSON.stringify(transformer.materialization))
            .not.toContain(credential);
        expect(transformer.materialization.additionalRedactionValues)
            .toBeUndefined();
        expect(transformer.redactionValues).toEqual([
            credential,
            `Bearer ${credential}`,
        ]);
        const expected = { OPENCODE_CONFIG_CONTENT: credential };
        expect(transformer.transform({
            OPENCODE_CONFIG_CONTENT: placeholder,
        })).toEqual(expected);
        expect(transformer.transform({
            OPENCODE_CONFIG_CONTENT: placeholder,
        })).toEqual(expected);
        expect(transformer.transform({ OTHER: 'public' })).toEqual({
            OTHER: 'public',
        });
    });

    it('redacts a bare host-Basic payload without treating its username as secret', () => {
        const username = 'opencode';
        const usernameAndPassword = `${username}:${credential}`;
        const basicPayload = Buffer.from(
            usernameAndPassword,
            'utf8',
        ).toString('base64');
        const transformer =
            createRunnerManagedProviderBindingLaunchEnvironmentTransformer({
                placeholder,
                credential,
                renderedPlaceholder: `Basic ${Buffer.from(
                    `${username}:${placeholder}`,
                    'utf8',
                ).toString('base64')}`,
                renderedCredential: `Basic ${basicPayload}`,
                isCurrent: () => true,
                materialization: {
                    v: 1,
                    kind: 'spawnEnv',
                    env: [{
                        name: 'AGENT_PROVIDER_AUTHORIZATION',
                        value: placeholder,
                        source: 'provider',
                    }],
                },
            });
        const redactor = createPluginInvocationSecretRedactor();
        const controller = new AbortController();
        const scope = {
            pluginId: 'acme.providers',
            generation: 'provider-p',
            correlationId: 'session-one',
        };
        redactor.beginInvocation(scope, controller.signal);
        for (const value of transformer.redactionValues) {
            redactor.registerRaw(scope, value);
        }

        expect(redactor.redact(scope, `result=${basicPayload}`))
            .toBe('result=[REDACTED]');
        expect(redactor.redact(scope, `provider=${username}`))
            .toBe(`provider=${username}`);
        controller.abort();
    });

    it.each([
        {
            label: 'ambient runner credential',
            materialization: {
                v: 1 as const,
                kind: 'engineConfig' as const,
                env: [{
                    name: 'HAPPIER_PROVIDER_API_KEY',
                    value: placeholder,
                    source: 'provider' as const,
                }],
                engineConfig: {
                    leaked: `Bearer ${credential}`,
                },
            },
        },
        {
            label: 'engine config',
            materialization: {
                v: 1 as const,
                kind: 'engineConfig' as const,
                env: [{
                    name: 'HAPPIER_PROVIDER_API_KEY',
                    value: placeholder,
                    source: 'provider' as const,
                }],
                engineConfig: { escaped: placeholder },
            },
        },
        {
            label: 'config file',
            materialization: {
                v: 1 as const,
                kind: 'configFile' as const,
                env: [{
                    name: 'HAPPIER_PROVIDER_API_KEY',
                    value: placeholder,
                    source: 'provider' as const,
                }],
                files: [{
                    relativePath: 'provider/config.json',
                    utf8: placeholder,
                }],
            },
        },
        {
            label: 'partial declared environment value',
            materialization: {
                v: 1 as const,
                kind: 'spawnEnv' as const,
                env: [{
                    name: 'HAPPIER_PROVIDER_API_KEY',
                    value: `prefix-${placeholder}`,
                    source: 'provider' as const,
                }],
            },
        },
        {
            label: 'missing credential slot',
            materialization: {
                v: 1 as const,
                kind: 'spawnEnv' as const,
                env: [{
                    name: 'HAPPIER_PROVIDER_API_KEY',
                    value: null,
                    source: 'provider' as const,
                }],
            },
        },
        {
            label: 'partial redaction value',
            materialization: {
                v: 1 as const,
                kind: 'spawnEnv' as const,
                env: [{
                    name: 'HAPPIER_PROVIDER_API_KEY',
                    value: placeholder,
                    source: 'provider' as const,
                }],
                additionalRedactionValues: [`prefix-${placeholder}`],
            },
        },
    ])('rejects credential escape through $label', ({ materialization }) => {
        expect(() => createRunnerManagedProviderBindingLaunchEnvironmentTransformer({
            placeholder,
            credential,
            renderedPlaceholder: `Bearer ${placeholder}`,
            renderedCredential: `Bearer ${credential}`,
            isCurrent: () => true,
            materialization,
        })).toThrow(/placeholder|credential/i);
    });

    it('rejects a moved, partial, missing, or already-secret launch slot and retired authority', () => {
        let current = true;
        const transformer =
            createRunnerManagedProviderBindingLaunchEnvironmentTransformer({
                placeholder,
                credential,
                renderedPlaceholder: `Bearer ${placeholder}`,
                renderedCredential: `Bearer ${credential}`,
                isCurrent: () => current,
                materialization: {
                    v: 1,
                    kind: 'spawnEnv',
                    env: [{
                        name: 'HAPPIER_PROVIDER_API_KEY',
                        value: placeholder,
                        source: 'provider',
                    }],
                },
            });
        expect(() => transformer.transform({
            OTHER: placeholder,
        })).toThrow(/escaped|slot/i);
        expect(() => transformer.transform({
            HAPPIER_PROVIDER_API_KEY: `prefix-${placeholder}`,
        })).toThrow(/exact|slot/i);
        expect(() => transformer.transform({
            HAPPIER_PROVIDER_API_KEY: credential,
        })).toThrow(/credential/i);
        expect(() => transformer.transform({
            HAPPIER_PROVIDER_API_KEY: 'missing-marker',
        })).toThrow(/exact|slot/i);
        current = false;
        expect(() => transformer.transform({
            HAPPIER_PROVIDER_API_KEY: placeholder,
        })).toThrow(/authority|current/i);
    });
});
