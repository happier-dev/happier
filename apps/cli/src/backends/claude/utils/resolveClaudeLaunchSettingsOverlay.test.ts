import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveClaudeLaunchSettingsOverlayArg } from './resolveClaudeLaunchSettingsOverlay';

describe('Claude pool launch settings', () => {
    const envKeys = ['HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', 'HAPPIER_CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT'] as const;
    let scope = createEnvKeyScope(envKeys);
    const roots: string[] = [];
    afterEach(() => {
        scope.restore();
        scope = createEnvKeyScope(envKeys);
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it.each(['inline', 'equals', 'file'] as const)('consolidates raw %s settings with the required launch overlay', (form) => {
        const root = mkdtempSync(join(tmpdir(), 'claude-user-settings-'));
        roots.push(root);
        const settingsPath = join(root, 'user.json');
        const base = { env: { KEEP: 'yes' }, cleanupPeriodDays: 1, theme: 'user' };
        const generatedPath = join(root, 'generated.json');
        writeFileSync(generatedPath, JSON.stringify({ theme: 'generated', hooks: { SessionStart: [] } }));
        writeFileSync(settingsPath, JSON.stringify(base));
        const value = form === 'file' ? settingsPath : JSON.stringify(base);
        const args = form === 'equals' ? [`--settings=${value}`, '--verbose'] : ['--settings', value, '--verbose'];
        const overlay = resolveClaudeLaunchSettingsOverlayArg({
            args, env: {}, settingsPath: generatedPath, launchSettings: { cleanupPeriodDays: 365 },
        });
        expect(args).toEqual(['--verbose']);
        expect(JSON.parse(readFileSync(overlay!, 'utf8'))).toEqual({ ...base, hooks: { SessionStart: [] }, cleanupPeriodDays: 365 });
        expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(base);
    });

    it('retains required generated allow rules alongside explicit user permissions', () => {
        const root = mkdtempSync(join(tmpdir(), 'claude-user-permissions-')); roots.push(root);
        const generatedPath = join(root, 'generated.json');
        writeFileSync(generatedPath, JSON.stringify({ permissions: { allow: ['mcp__happier__change_title'] } }));
        const args = ['--settings', JSON.stringify({ permissions: { allow: ['Read'], deny: ['Write'], defaultMode: 'acceptEdits' } })];
        const overlay = resolveClaudeLaunchSettingsOverlayArg({ args, env: {}, settingsPath: generatedPath, launchSettings: {} });
        expect(JSON.parse(readFileSync(overlay!, 'utf8')).permissions).toEqual({
            allow: ['mcp__happier__change_title', 'Read'], deny: ['Write'], defaultMode: 'acceptEdits',
        });
    });

    it('reads explicit settings files relative to the actual child working directory', () => {
        const root = mkdtempSync(join(tmpdir(), 'claude-relative-settings-')); roots.push(root);
        writeFileSync(join(root, 'relative-settings.json'), JSON.stringify({ theme: 'session-file' }));
        const overlay = resolveClaudeLaunchSettingsOverlayArg({
            args: ['--settings', 'relative-settings.json'], cwd: root, env: {}, settingsPath: undefined,
            launchSettings: { cleanupPeriodDays: 365 },
        });
        expect(JSON.parse(overlay!)).toEqual({ theme: 'session-file', cleanupPeriodDays: 365 });
    });

    it('keeps an explicit settings file as a file when no launch overlay is required', () => {
        const root = mkdtempSync(join(tmpdir(), 'claude-settings-noop-')); roots.push(root);
        const path = join(root, 'settings.json');
        writeFileSync(path, JSON.stringify({ env: { PRIVATE_FILE_VALUE: 'file-only' } }));
        const args = ['--settings', path];
        expect(resolveClaudeLaunchSettingsOverlayArg({ args, env: {}, settingsPath: undefined, launchSettings: {} })).toBe(path);
        expect(args).toEqual([]);
    });

    it('rejects malformed explicit user settings instead of silently removing the source', () => {
        const args = ['--settings', '{broken'];
        expect(() => resolveClaudeLaunchSettingsOverlayArg({
            args, env: {}, settingsPath: undefined, launchSettings: { cleanupPeriodDays: 365 },
        })).toThrow('Unable to read Claude launch settings');
    });

    it.each([{ rawDays: 1, sameHome: false, expected: 365 }, { rawDays: 1000, sameHome: false, expected: 1000 }, { rawDays: 1, sameHome: true, expected: 1 }])('respects the actual raw retention choice $rawDays (same home=$sameHome)', ({ rawDays, sameHome, expected }) => {
        const root = mkdtempSync(join(tmpdir(), 'claude-raw-retention-')); roots.push(root);
        const native = join(root, 'native'); const active = sameHome ? native : join(root, 'account');
        mkdirSync(join(native, 'projects'), { recursive: true });
        writeFileSync(join(native, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }));
        if (!sameHome) {
            mkdirSync(active);
            symlinkSync(join(native, 'projects'), join(active, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
            writeFileSync(join(active, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }));
        }
        const args = ['--settings', JSON.stringify({ cleanupPeriodDays: rawDays })];
        const overlay = resolveClaudeLaunchSettingsOverlayArg({ args, settingsPath: undefined, launchSettings: {},
            env: { CLAUDE_CONFIG_DIR: active, HAPPIER_CLAUDE_NATIVE_CONFIG_DIR: native } });
        expect(JSON.parse(overlay!).cleanupPeriodDays).toBe(expected);
    });

    it.each([
        { nativeDays: 365, activeDays: undefined, shared: true, invalidActive: false, expected: 365 },
        { nativeDays: 365, activeDays: 7, shared: true, invalidActive: false, expected: 365 },
        { nativeDays: 7, activeDays: undefined, shared: true, invalidActive: false, expected: undefined },
        { nativeDays: 7, activeDays: 1, shared: true, invalidActive: false, expected: 7 },
        { nativeDays: 7, activeDays: 365, shared: true, invalidActive: false, expected: undefined },
        { nativeDays: undefined, activeDays: 7, shared: true, invalidActive: false, expected: undefined },
        { nativeDays: undefined, activeDays: undefined, shared: true, invalidActive: false, expected: undefined },
        { nativeDays: 365, activeDays: 7, shared: false, invalidActive: false, expected: undefined },
        { nativeDays: 365, activeDays: undefined, shared: true, invalidActive: true, expected: undefined },
    ])('protects native retention only for the shared transcript store ($nativeDays/$activeDays, shared=$shared, invalid=$invalidActive)', ({ nativeDays, activeDays, shared, invalidActive, expected }) => {
        const root = mkdtempSync(join(tmpdir(), 'happier-claude-retention-overlay-'));
        roots.push(root);
        const nativeHome = join(root, 'custom-native');
        const activeHome = join(root, 'active');
        mkdirSync(join(nativeHome, 'projects'), { recursive: true });
        mkdirSync(activeHome);
        if (shared) symlinkSync(join(nativeHome, 'projects'), join(activeHome, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
        else mkdirSync(join(activeHome, 'projects'));
        writeFileSync(join(nativeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: nativeDays }));
        writeFileSync(join(activeHome, 'settings.json'), invalidActive ? '{' : JSON.stringify({ cleanupPeriodDays: activeDays }));
        const settingsPath = join(root, 'hooks.json');
        const base = JSON.stringify({ permissions: { allow: ['mcp__happier__change_title'] } });
        writeFileSync(settingsPath, base);
        const overlay = resolveClaudeLaunchSettingsOverlayArg({
            env: { CLAUDE_CONFIG_DIR: activeHome, HAPPIER_CLAUDE_NATIVE_CONFIG_DIR: nativeHome },
            settingsPath,
            launchSettings: {},
        });
        expect(JSON.parse(readFileSync(overlay!, 'utf8')).cleanupPeriodDays).toBe(expected);
        expect(readFileSync(settingsPath, 'utf8')).toBe(base);
    });

    it.each([
        { kind: 'group', optOut: undefined, expected: false },
        { kind: 'group', optOut: '1', expected: true },
        { kind: 'profile', optOut: '0', expected: undefined },
        { kind: 'native', optOut: '0', expected: undefined },
    ])('merges the $kind usage-limit preference (opt-out $optOut) into one private overlay', ({ kind, optOut, expected }) => {
        scope.patch({
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify(kind === 'native' ? [] : [{
                kind, serviceId: 'claude-subscription', profileId: 'work', groupId: 'pool',
                activeProfileId: 'work', fallbackProfileId: 'work', generation: 1,
            }]),
            HAPPIER_CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT: optOut,
        });
        const root = mkdtempSync(join(tmpdir(), 'happier-pool-launch-settings-'));
        roots.push(root);
        const settingsPath = join(root, 'launch.json');
        const base = JSON.stringify({ permissions: { allow: ['mcp__happier__change_title'] } });
        writeFileSync(settingsPath, base);
        const overlay = resolveClaudeLaunchSettingsOverlayArg({ settingsPath, launchSettings: { ultracode: true }, env: process.env });
        expect(overlay).toBeTruthy();
        const settings: Record<string, unknown> = JSON.parse(readFileSync(overlay!, 'utf8'));
        expect(settings.autoContinueAtUsageLimit).toBe(expected);
        expect(settings.ultracode).toBe(true);
        expect(settings.permissions).toEqual({ allow: ['mcp__happier__change_title'] });
        expect(readFileSync(settingsPath, 'utf8')).toBe(base);
    });
});
