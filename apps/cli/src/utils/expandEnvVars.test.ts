/**
 * Unit tests for environment variable expansion utility
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

import { expandEnvironmentVariables } from './expandEnvVars';

describe('expandEnvironmentVariables', () => {
    const originalDebug = process.env.DEBUG;

    function muteLogger(): void {
        vi.spyOn(logger, 'debug').mockImplementation(() => {});
        vi.spyOn(logger, 'warn').mockImplementation(() => {});
        vi.spyOn(logger, 'info').mockImplementation(() => {});
    }

    beforeEach(() => {
        muteLogger();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (originalDebug === undefined) {
            delete process.env.DEBUG;
        } else {
            process.env.DEBUG = originalDebug;
        }
    });

    it('keeps referenced environment names and values out of diagnostics', () => {
        process.env.DEBUG = '1';
        const privateSourceName = 'PRIVATE_CUSTOMER_SOURCE_TOKEN';
        const privateEmptyName = 'PRIVATE_CUSTOMER_EMPTY_TOKEN';
        const privateMissingName = 'PRIVATE_CUSTOMER_MISSING_TOKEN';
        const privateSourceValue = 'private-source-value';

        const result = expandEnvironmentVariables({
            RESOLVED: `\${${privateSourceName}}`,
            EMPTY: `\${${privateEmptyName}}`,
            MISSING: `\${${privateMissingName}}`,
        }, {
            [privateSourceName]: privateSourceValue,
            [privateEmptyName]: '',
        });

        expect(result).toEqual({
            RESOLVED: privateSourceValue,
            EMPTY: '',
            MISSING: `\${${privateMissingName}}`,
        });
        const diagnostics = JSON.stringify({
            debug: vi.mocked(logger.debug).mock.calls,
            warn: vi.mocked(logger.warn).mock.calls,
        });
        expect(diagnostics).not.toContain(privateSourceName);
        expect(diagnostics).not.toContain(privateEmptyName);
        expect(diagnostics).not.toContain(privateMissingName);
        expect(diagnostics).not.toContain(privateSourceValue);
    });

    it('captures only actually consumed machine-env values for the owning diagnostic lease', () => {
        const redaction = createProviderRedactionLease({ values: [] });
        try {
            expect(expandEnvironmentVariables({
                AUTH: 'Bearer ${TOKEN:-${UNUSED}}',
                FALLBACK_AUTH: 'Bearer ${MISSING:-${FALLBACK}}',
            }, { TOKEN: 'selected-machine-token', UNUSED: 'unused-fallback-token',
                FALLBACK: 'selected-fallback-token', UNREFERENCED: 'unreferenced-token' }, {
                onResolvedValue: value => redaction.add([value]),
            })).toEqual({ AUTH: 'Bearer selected-machine-token', FALLBACK_AUTH: 'Bearer selected-fallback-token' });
            expect(redaction.redact('selected-machine-token|selected-fallback-token|unused-fallback-token|unreferenced-token'))
                .toBe('[REDACTED]|[REDACTED]|unused-fallback-token|unreferenced-token');
        } finally { redaction.close(); }
    });

    it('should expand multiple ${VAR} references in same value', () => {
        const envVars = {
            PATH: '${BIN_DIR}:${LIB_DIR}'
        };
        const sourceEnv = {
            BIN_DIR: '/usr/bin',
            LIB_DIR: '/usr/lib'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            PATH: '/usr/bin:/usr/lib'
        });
    });

    it('should handle partial expansion when some variables missing', () => {
        const envVars = {
            MIXED: '${EXISTS}:${MISSING}:${ALSO_EXISTS}'
        };
        const sourceEnv = {
            EXISTS: 'found1',
            ALSO_EXISTS: 'found2'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            MIXED: 'found1:${MISSING}:found2'
        });
    });

    it('should use default for ${VAR:-default} when VAR is missing', () => {
        const envVars = {
            TARGET: '${MISSING_VAR:-default-value}',
        };
        const sourceEnv = {};

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'default-value',
        });
    });

    it('reuses ${VAR:=default} assignments for subsequent references in the same value', () => {
        const envVars = {
            TARGET: '${MISSING_VAR:=default-value}-${MISSING_VAR}',
        };
        const sourceEnv = {};

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'default-value-default-value',
        });
    });

    it('supports nested defaults in := assignments', () => {
        const envVars = {
            TARGET: '${MISSING_VAR:=${FALLBACK_VAR:-default-value}}-${MISSING_VAR}',
        };
        const sourceEnv = {};

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'default-value-default-value',
        });
    });

    it('treats empty string as missing for ${VAR:-default}', () => {
        const envVars = {
            TARGET: '${EMPTY_VAR:-default-value}',
        };
        const sourceEnv = {
            EMPTY_VAR: '',
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'default-value',
        });
    });

    it('treats empty string as missing for ${VAR:=default}', () => {
        const envVars = {
            TARGET: '${EMPTY_VAR:=default-value}',
        };
        const sourceEnv = {
            EMPTY_VAR: '',
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'default-value',
        });
    });

    it('should handle multiple variables with same source', () => {
        const envVars = {
            VAR1: '${SHARED}',
            VAR2: 'prefix-${SHARED}',
            VAR3: '${SHARED}-suffix'
        };
        const sourceEnv = {
            SHARED: 'common-value'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            VAR1: 'common-value',
            VAR2: 'prefix-common-value',
            VAR3: 'common-value-suffix'
        });
    });

    it('should not modify original envVars object', () => {
        const envVars = {
            TARGET: '${SOURCE}'
        };
        const sourceEnv = {
            SOURCE: 'value'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);

        // Original should be unchanged
        expect(envVars).toEqual({
            TARGET: '${SOURCE}'
        });

        // Result should be expanded
        expect(result).toEqual({
            TARGET: 'value'
        });
    });

    it('should use process.env as default source when not provided', () => {
        // Save original
        const originalPath = process.env.PATH;

        const envVars = {
            MY_PATH: '${PATH}'
        };

        const result = expandEnvironmentVariables(envVars);
        expect(result.MY_PATH).toBe(originalPath);
    });

    it('should handle nested braces correctly', () => {
        const envVars = {
            COMPLEX: '${VAR1}/${VAR2}/literal-${}'
        };
        const sourceEnv = {
            VAR1: 'part1',
            VAR2: 'part2'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            COMPLEX: 'part1/part2/literal-${}'
        });
    });

    it('should handle variables with underscores and numbers', () => {
        const envVars = {
            TARGET: '${MY_VAR_123}'
        };
        const sourceEnv = {
            MY_VAR_123: 'value-with-numbers'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'value-with-numbers'
        });
    });

    it('should handle real-world profile environment variables scenario', () => {
        const profileEnvVars = {
            ANTHROPIC_AUTH_TOKEN: '${Z_AI_AUTH_TOKEN}',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            OPENAI_API_KEY: '${Z_OPENAI_KEY}',
            CUSTOM_PATH: '/custom:${HOME}/bin'
        };
        const daemonEnv = {
            Z_AI_AUTH_TOKEN: 'sk-ant-12345',
            Z_OPENAI_KEY: 'sk-proj-67890',
            HOME: '/Users/test'
        };

        const result = expandEnvironmentVariables(profileEnvVars, daemonEnv);
        expect(result).toEqual({
            ANTHROPIC_AUTH_TOKEN: 'sk-ant-12345',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            OPENAI_API_KEY: 'sk-proj-67890',
            CUSTOM_PATH: '/custom:/Users/test/bin'
        });
    });

    it('should handle empty objects', () => {
        const result = expandEnvironmentVariables({}, {});
        expect(result).toEqual({});
    });

    it('should not expand malformed ${} references', () => {
        const envVars = {
            BAD1: '${',
            BAD2: '${}',
            BAD3: 'text-${',
            GOOD: '${VALID}'
        };
        const sourceEnv = {
            VALID: 'expanded'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            BAD1: '${',
            BAD2: '${}',
            BAD3: 'text-${',
            GOOD: 'expanded'
        });
    });
});
