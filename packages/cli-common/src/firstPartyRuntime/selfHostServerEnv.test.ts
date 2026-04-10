import { describe, expect, it } from 'vitest';

import {
    applyEnvOverridesToEnvText,
    mergeSelfHostServerEnvText,
    resolveConfiguredSelfHostBaseUrl,
} from './selfHostServerEnv.js';

describe('applyEnvOverridesToEnvText', () => {
    it('rejects env override keys with newlines', () => {
        expect(() => applyEnvOverridesToEnvText('PORT=3005\n', { 'BAD\nKEY': '1' })).toThrow(/env override/i);
    });

    it('rejects env override values with newlines', () => {
        expect(() => applyEnvOverridesToEnvText('PORT=3005\n', { PORT: '3005\nBAD=1' })).toThrow(/env override/i);
    });
});

describe('resolveConfiguredSelfHostBaseUrl', () => {
    it('prefers env overrides over the fallback baseUrl', () => {
        expect(resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: 'http://127.0.0.1:3005',
            envText: 'PORT=4010\nHAPPIER_SERVER_HOST=0.0.0.0\n',
        })).toBe('http://127.0.0.1:4010');
    });

    it('formats IPv6 hosts with brackets', () => {
        expect(resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: 'http://127.0.0.1:3005',
            envText: 'PORT=4010\nHAPPIER_SERVER_HOST=::1\n',
        })).toBe('http://[::1]:4010');
    });
});

describe('mergeSelfHostServerEnvText', () => {
    it('preserves user-owned overrides while regenerating managed runtime keys', () => {
        const merged = mergeSelfHostServerEnvText({
            baseEnvText: [
                'PORT=3005',
                'HAPPIER_SERVER_HOST=127.0.0.1',
                'DATABASE_URL=file:/new.sqlite',
                'NODE_PATH=/new/node_modules',
                'HAPPIER_SQLITE_MIGRATIONS_DIR=/new/migrations',
                'HAPPIER_SERVER_UI_DIR=/new/ui',
                '',
            ].join('\n'),
            existingEnvText: [
                'PORT=4010',
                'HAPPIER_PUBLIC_SERVER_URL=https://relay.example.test',
                'NODE_PATH=/old/node_modules',
                'HAPPIER_SQLITE_MIGRATIONS_DIR=/old/migrations',
                'HAPPIER_SERVER_UI_DIR=/old/ui',
                'CUSTOM_RUNTIME_FLAG=enabled',
                '',
            ].join('\n'),
        });

        expect(merged).toContain('PORT=4010');
        expect(merged).toContain('HAPPIER_PUBLIC_SERVER_URL=https://relay.example.test');
        expect(merged).toContain('CUSTOM_RUNTIME_FLAG=enabled');
        expect(merged).toContain('NODE_PATH=/new/node_modules');
        expect(merged).toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/new/migrations');
        expect(merged).toContain('HAPPIER_SERVER_UI_DIR=/new/ui');
        expect(merged).not.toContain('NODE_PATH=/old/node_modules');
        expect(merged).not.toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/old/migrations');
        expect(merged).not.toContain('HAPPIER_SERVER_UI_DIR=/old/ui');
    });
});
