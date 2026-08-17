import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The energy provider must enclose EVERY Voice surface, including the sidebar.
 *
 * This is a source-text guard because the failure it prevents is invisible to
 * every component test: each of those supplies the provider itself, so none can
 * observe the production mount site. The real app crashed on desktop web —
 * `useVoiceEnergy must be used inside VoiceEnergyProvider`, taking the whole
 * tree to the crash boundary — while 254 unit tests stayed green.
 *
 * The cause was a tree-shape mistake, not a logic one. `SidebarNavigator` is
 * mounted in the ROOT layout and its drawer content renders
 * `<VoiceSurface variant="sidebar" />`; the provider had been mounted in the
 * nested `(app)` route layout, strictly BELOW it. The phone mount lives inside
 * that route layout, so the compact layout worked and hid the break.
 */
function readApp(rel: string): string {
    const ui = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    return readFileSync(join(ui, rel), 'utf8');
}

describe('VoiceEnergyAppProvider mount site', () => {
    it('is mounted in the root layout, which is where the sidebar lives', () => {
        const root = readApp(join('app', '_layout.tsx'));
        expect(root).toContain('VoiceEnergyAppProvider');
    });

    it('encloses SidebarNavigator rather than sitting below it', () => {
        const root = readApp(join('app', '_layout.tsx'));
        // `appContent` holds SidebarNavigator and is wrapped by the provider.
        const provider = root.indexOf('<VoiceEnergyAppProvider>');
        const close = root.indexOf('</VoiceEnergyAppProvider>');
        expect(provider).toBeGreaterThan(-1);
        expect(close).toBeGreaterThan(provider);
        expect(root.slice(provider, close)).toContain('appContent');
    });

    it('does not rely on the nested route layout, which the sidebar sits above', () => {
        const nested = readApp(join('app', '(app)', '_layout.tsx'));
        expect(nested).not.toContain('VoiceEnergyAppProvider');
    });
});
