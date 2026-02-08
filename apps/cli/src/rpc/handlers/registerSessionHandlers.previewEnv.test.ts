/**
 * Tests for the `preview-env` RPC handler.
 *
 * Ensures the daemon can safely preview effective environment variable values
 * (including ${VAR} expansion) without exposing secrets by default.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerSessionHandlers } from './registerSessionHandlers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createEncryptedRpcTestClient } from './encryptedRpc.testHelper';

function createTestRpcManager(params?: { scopePrefix?: string }) {
    const scopePrefix = params?.scopePrefix ?? 'machine-test';
    return createEncryptedRpcTestClient({
        scopePrefix,
        encryptionKey: new Uint8Array(32).fill(7),
        logger: () => undefined,
        registerHandlers: (manager) => registerSessionHandlers(manager, process.cwd()),
    });
}

type EnvPreviewSecretsPolicy = 'none' | 'redacted' | 'full';
type PreviewEnvSensitivitySource = 'forced' | 'hinted' | 'none';
type PreviewEnvDisplay = 'full' | 'redacted' | 'hidden' | 'unset';

interface PreviewEnvRequest {
    keys: string[];
    extraEnv?: Record<string, string>;
    sensitiveKeys?: string[];
}

interface PreviewEnvValue {
    value: string | null;
    isSensitive: boolean;
    isForcedSensitive: boolean;
    sensitivitySource: PreviewEnvSensitivitySource;
    display: PreviewEnvDisplay;
}

interface PreviewEnvResponse {
    policy: EnvPreviewSecretsPolicy;
    values: Record<string, PreviewEnvValue>;
}

describe('registerCommonHandlers preview-env', () => {
    const trackedEnvKeys = [
        'PATH',
        'HAPPIER_ENV_PREVIEW_SECRETS',
        'npm_config_registry',
        'SECRET_TOKEN',
        'ANTHROPIC_AUTH_TOKEN',
        'HAPPIER_ENV_PREVIEW_SECRET_NAME_REGEX',
        'BAR_TOKEN',
    ] as const;
    const baselineEnv: Record<string, string | undefined> = Object.fromEntries(
        trackedEnvKeys.map((key) => [key, process.env[key]]),
    );

    const restoreTrackedEnv = () => {
        for (const key of trackedEnvKeys) {
            const value = baselineEnv[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };

    beforeEach(() => {
        restoreTrackedEnv();
    });

    afterEach(() => {
        restoreTrackedEnv();
    });

    it('returns effective env values with embedded ${VAR} expansion', async () => {
        process.env.PATH = '/usr/bin';
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'none';

        const { call } = createTestRpcManager();

        const result = await call<PreviewEnvResponse, PreviewEnvRequest>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['PATH'],
            extraEnv: {
                PATH: '/opt/bin:${PATH}',
            },
        });

        expect(result.policy).toBe('none');
        expect(result.values.PATH.display).toBe('full');
        expect(result.values.PATH.value).toBe('/opt/bin:/usr/bin');
    });

    it('accepts lowercase env var keys', async () => {
        process.env.npm_config_registry = 'https://example.test';
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'none';

        const { call } = createTestRpcManager();

        const result = await call<PreviewEnvResponse, PreviewEnvRequest>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['npm_config_registry'],
        });

        expect(result.policy).toBe('none');
        expect(result.values.npm_config_registry.display).toBe('full');
        expect(result.values.npm_config_registry.value).toBe('https://example.test');
    });

    it('rejects dangerous prototype keys', async () => {
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'none';

        const { call } = createTestRpcManager();

        const result = await call<{ error: string }, { keys: string[] }>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['__proto__'],
        });

        expect(result.error).toMatch(/Invalid env var key/);
    });

    it('hides sensitive values when HAPPIER_ENV_PREVIEW_SECRETS=none', async () => {
        process.env.SECRET_TOKEN = 'sk-1234567890';
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'none';

        const { call } = createTestRpcManager();

        const result = await call<PreviewEnvResponse, PreviewEnvRequest>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['ANTHROPIC_AUTH_TOKEN'],
            extraEnv: {
                ANTHROPIC_AUTH_TOKEN: '${SECRET_TOKEN}',
            },
            sensitiveKeys: ['SECRET_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
        });

        expect(result.policy).toBe('none');
        expect(result.values.ANTHROPIC_AUTH_TOKEN.isSensitive).toBe(true);
        expect(result.values.ANTHROPIC_AUTH_TOKEN.isForcedSensitive).toBe(true);
        expect(result.values.ANTHROPIC_AUTH_TOKEN.sensitivitySource).toBe('forced');
        expect(result.values.ANTHROPIC_AUTH_TOKEN.display).toBe('hidden');
        expect(result.values.ANTHROPIC_AUTH_TOKEN.value).toBeNull();
    });

    it('redacts sensitive values when HAPPIER_ENV_PREVIEW_SECRETS=redacted', async () => {
        process.env.SECRET_TOKEN = 'sk-1234567890';
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'redacted';

        const { call } = createTestRpcManager();

        const result = await call<PreviewEnvResponse, PreviewEnvRequest>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['ANTHROPIC_AUTH_TOKEN'],
            extraEnv: {
                ANTHROPIC_AUTH_TOKEN: '${SECRET_TOKEN}',
            },
            sensitiveKeys: ['SECRET_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
        });

        expect(result.policy).toBe('redacted');
        expect(result.values.ANTHROPIC_AUTH_TOKEN.display).toBe('redacted');
        expect(result.values.ANTHROPIC_AUTH_TOKEN.value).toBe('sk-*******890');
    });

    it('returns full sensitive values when HAPPIER_ENV_PREVIEW_SECRETS=full', async () => {
        process.env.SECRET_TOKEN = 'sk-1234567890';
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'full';

        const { call } = createTestRpcManager();

        const result = await call<PreviewEnvResponse, PreviewEnvRequest>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['ANTHROPIC_AUTH_TOKEN'],
            extraEnv: {
                ANTHROPIC_AUTH_TOKEN: '${SECRET_TOKEN}',
            },
            sensitiveKeys: ['SECRET_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
        });

        expect(result.policy).toBe('full');
        expect(result.values.ANTHROPIC_AUTH_TOKEN.display).toBe('full');
        expect(result.values.ANTHROPIC_AUTH_TOKEN.value).toBe('sk-1234567890');
    });

    it('supports overriding the secret name regex via HAPPIER_ENV_PREVIEW_SECRET_NAME_REGEX', async () => {
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'none';
        process.env.HAPPIER_ENV_PREVIEW_SECRET_NAME_REGEX = '^FOO$';
        process.env.BAR_TOKEN = 'sk-1234567890';

        const { call } = createTestRpcManager();

        const result = await call<PreviewEnvResponse, PreviewEnvRequest>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['BAR_TOKEN'],
        });

        expect(result.policy).toBe('none');
        expect(result.values.BAR_TOKEN.isSensitive).toBe(false);
        expect(result.values.BAR_TOKEN.isForcedSensitive).toBe(false);
        expect(result.values.BAR_TOKEN.sensitivitySource).toBe('none');
        expect(result.values.BAR_TOKEN.display).toBe('full');
        expect(result.values.BAR_TOKEN.value).toBe('sk-1234567890');
    });

    it('falls back to default secret regex when HAPPIER_ENV_PREVIEW_SECRET_NAME_REGEX is invalid', async () => {
        process.env.HAPPIER_ENV_PREVIEW_SECRETS = 'none';
        process.env.HAPPIER_ENV_PREVIEW_SECRET_NAME_REGEX = '(';
        process.env.BAR_TOKEN = 'sk-1234567890';

        const { call } = createTestRpcManager();

        const result = await call<PreviewEnvResponse, PreviewEnvRequest>(RPC_METHODS.PREVIEW_ENV, {
            keys: ['BAR_TOKEN'],
        });

        expect(result.policy).toBe('none');
        expect(result.values.BAR_TOKEN.isSensitive).toBe(true);
        expect(result.values.BAR_TOKEN.isForcedSensitive).toBe(true);
        expect(result.values.BAR_TOKEN.sensitivitySource).toBe('forced');
        expect(result.values.BAR_TOKEN.display).toBe('hidden');
        expect(result.values.BAR_TOKEN.value).toBeNull();
    });
});
