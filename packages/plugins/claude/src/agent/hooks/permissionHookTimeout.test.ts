import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS,
    PERMISSION_HOOK_TIMEOUT_ENV_VAR,
    resolveClaudePermissionHookCeilingMs,
    resolveClaudePermissionHookTimeoutSeconds,
} from './permissionHookTimeout.js';

describe('resolveClaudePermissionHookTimeoutSeconds', () => {
    it('defaults to an effectively-unlimited finite 7 days', () => {
        expect(DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS).toBe(604800);
        expect(resolveClaudePermissionHookTimeoutSeconds()).toBe(604800);
        expect(resolveClaudePermissionHookTimeoutSeconds({ env: {} })).toBe(604800);
    });

    it('honors a positive-integer env override', () => {
        expect(resolveClaudePermissionHookTimeoutSeconds({
            env: { [PERMISSION_HOOK_TIMEOUT_ENV_VAR]: '120' },
        })).toBe(120);
    });

    it('lets an explicit value win over the env override', () => {
        expect(resolveClaudePermissionHookTimeoutSeconds({
            explicitSeconds: 45,
            env: { [PERMISSION_HOOK_TIMEOUT_ENV_VAR]: '120' },
        })).toBe(45);
    });

    it('ignores a non-positive / non-numeric env value and falls back to the default', () => {
        for (const bad of ['0', '-5', 'abc', '']) {
            expect(resolveClaudePermissionHookTimeoutSeconds({
                env: { [PERMISSION_HOOK_TIMEOUT_ENV_VAR]: bad },
            })).toBe(604800);
        }
    });

    it('expresses the ceiling in milliseconds for the host server', () => {
        expect(resolveClaudePermissionHookCeilingMs()).toBe(604800 * 1000);
        expect(resolveClaudePermissionHookCeilingMs({
            env: { [PERMISSION_HOOK_TIMEOUT_ENV_VAR]: '90' },
        })).toBe(90_000);
    });
});
