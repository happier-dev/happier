import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        const overlay = resolveClaudeLaunchSettingsOverlayArg({ settingsPath, launchSettings: { ultracode: true } });
        expect(overlay).toBeTruthy();
        const settings: Record<string, unknown> = JSON.parse(readFileSync(overlay!, 'utf8'));
        expect(settings.autoContinueAtUsageLimit).toBe(expected);
        expect(settings.ultracode).toBe(true);
        expect(settings.permissions).toEqual({ allow: ['mcp__happier__change_title'] });
        expect(readFileSync(settingsPath, 'utf8')).toBe(base);
    });
});
