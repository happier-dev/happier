import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRoutineServerSelectionScope } from './serverSelectionScope';

describe('resolveRoutineServerSelectionScope', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each(['/desktop/app-window', '/desktop/window'])('keeps %s Home selection local after route navigation', (pathname) => {
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('window', { location: { href: `http://localhost:8081${pathname}` } });
        expect(resolveRoutineServerSelectionScope('web', true)).toBe('tab');
        window.location.href = 'http://localhost:8081/settings';
        expect(resolveRoutineServerSelectionScope('web', true)).toBe('tab');
    });

    it('keeps routine web selection in the current tab', () => {
        expect(resolveRoutineServerSelectionScope('web')).toBe('tab');
    });

    it('uses device scope for a web renderer hosted by the desktop app', () => {
        expect(resolveRoutineServerSelectionScope('web', true)).toBe('device');
    });

    it.each(['ios', 'android', 'macos', 'windows'])('uses device scope for %s', (platformOS) => {
        expect(resolveRoutineServerSelectionScope(platformOS)).toBe('device');
    });
});
