import { describe, expect, it } from 'vitest';

import {
    buildClaudeHookPluginHooks,
    buildClaudeHookPluginManifest,
    buildClaudeHookSettingsOverlay,
} from './settings.js';

describe('Claude hook settings leaf', () => {
    it('builds the non-hook settings overlay without lifecycle hooks', () => {
        const settings = buildClaudeHookSettingsOverlay();

        expect(settings.hooks).toBeUndefined();
        expect(settings.permissions?.allow).toEqual(expect.arrayContaining([
            'mcp__happier__change_title',
            'mcp__happier__session_title_set',
        ]));
    });

    it('builds the complete lifecycle hook manifest for a session plugin', () => {
        const params = {
            port: 43123,
            nodeExecutable: '/bin/node',
            sessionForwarderScript: '/app/session_hook_forwarder.cjs',
            sessionHookSecretFile: '/tmp/happier-hooks/session.secret',
        } as Parameters<typeof buildClaudeHookPluginHooks>[0] & { sessionHookSecretFile: string };
        const hooksJson = buildClaudeHookPluginHooks(params);

        for (const hookName of [
            'SessionStart',
            'UserPromptSubmit',
            'Stop',
            'StopFailure',
            'SessionEnd',
            'PostToolUse',
            'SubagentStart',
            'SubagentStop',
        ]) {
            const command = hooksJson.hooks[hookName]?.[0]?.hooks[0]?.command;
            expect(command).toBe(`'/bin/node' '/app/session_hook_forwarder.cjs' '43123' '${hookName}' '--secret-file' '/tmp/happier-hooks/session.secret'`);
            expect(command).not.toContain('session-secret-123');
        }
        expect(hooksJson.hooks.PermissionRequest).toBeUndefined();
        expect(hooksJson.hooks.PreToolUse).toBeUndefined();
    });

    it('adds PermissionRequest and AskUserQuestion PreToolUse hooks when local permission bridge is enabled', () => {
        const hooksJson = buildClaudeHookPluginHooks({
            port: 43124,
            nodeExecutable: '/bin/node',
            sessionForwarderScript: '/app/session_hook_forwarder.cjs',
            permissionForwarderScript: '/app/permission_hook_forwarder.cjs',
            enableLocalPermissionBridge: true,
            permissionHookSecretFile: '/tmp/happier-hooks/permission.secret',
        });

        expect(hooksJson.hooks.PermissionRequest?.[0]?.matcher).toBe('');
        expect(hooksJson.hooks.PermissionRequest?.[0]?.hooks[0]?.command).toBe(
            "'/bin/node' '/app/permission_hook_forwarder.cjs' '43124' 'PermissionRequest' '--secret-file' '/tmp/happier-hooks/permission.secret'",
        );
        expect(hooksJson.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion');
        expect(hooksJson.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(
            "'/bin/node' '/app/permission_hook_forwarder.cjs' '43124' 'PreToolUse' '--secret-file' '/tmp/happier-hooks/permission.secret'",
        );
        expect(JSON.stringify(hooksJson)).not.toContain('secret-123');
    });

    it('installs an effectively-unlimited (7d) timeout on the permission hooks only', () => {
        const hooksJson = buildClaudeHookPluginHooks({
            port: 43125,
            nodeExecutable: '/bin/node',
            sessionForwarderScript: '/app/session_hook_forwarder.cjs',
            permissionForwarderScript: '/app/permission_hook_forwarder.cjs',
            enableLocalPermissionBridge: true,
        });

        // The permission hooks Claude itself enforces a timeout on must be effectively unlimited
        // (7 days) so a user can answer overnight; session lifecycle hooks keep no special timeout.
        expect(hooksJson.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(604800);
        expect(hooksJson.hooks.PreToolUse?.[0]?.hooks[0]?.timeout).toBe(604800);
        for (const hookName of ['SessionStart', 'Stop', 'PostToolUse']) {
            expect(hooksJson.hooks[hookName]?.[0]?.hooks[0]?.timeout).toBeUndefined();
        }
    });

    it('honors an explicit permission-hook timeout seconds override', () => {
        const hooksJson = buildClaudeHookPluginHooks({
            port: 43126,
            nodeExecutable: '/bin/node',
            sessionForwarderScript: '/app/session_hook_forwarder.cjs',
            permissionForwarderScript: '/app/permission_hook_forwarder.cjs',
            enableLocalPermissionBridge: true,
            permissionHookTimeoutSeconds: 120,
        });

        expect(hooksJson.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(120);
        expect(hooksJson.hooks.PreToolUse?.[0]?.hooks[0]?.timeout).toBe(120);
    });

    it('quotes shell-sensitive POSIX argv without command substitution or token splitting', () => {
        const hooksJson = buildClaudeHookPluginHooks({
            port: 43127,
            nodeExecutable: "/Applications/Happier $() `node`/node",
            sessionForwarderScript: "/tmp/hook path/forwarder's \\\\script.cjs",
            sessionHookSecretFile:
                "/tmp/secret path/$() `secret` &|<>^%!()'token",
        });

        expect(hooksJson.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
            "'/Applications/Happier $() `node`/node' "
            + "'/tmp/hook path/forwarder'\\''s \\\\script.cjs' "
            + "'43127' 'Stop' '--secret-file' "
            + "'/tmp/secret path/$() `secret` &|<>^%!()'\\''token'",
        );
    });

    it('builds a session-scoped Claude plugin manifest', () => {
        expect(buildClaudeHookPluginManifest({ instanceId: 'abc123' })).toEqual({
            name: 'happier-session-hooks-abc123',
            version: '1.0.0',
            description: 'Happier session-scoped Claude Code hooks.',
            author: { name: 'Happier' },
        });
    });
});
