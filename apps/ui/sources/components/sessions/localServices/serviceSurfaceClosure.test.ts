import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_ROOT = path.resolve(__dirname, '../../../..');

function read(relative: string): string {
    return readFileSync(path.join(UI_ROOT, relative), 'utf8');
}

function exists(relative: string): boolean {
    return existsSync(path.join(UI_ROOT, relative));
}

describe('local-services surface single-owner closure', () => {
    it('DetectedLocalServicesPane renders via buildLocalServiceRows + ServiceRowView, not separate region builders', () => {
        const pane = read('sources/components/sessions/localServices/DetectedLocalServicesPane.tsx');
        expect(pane).toContain('buildLocalServiceRows');
        expect(pane).toContain('ServiceRowView');
        // The deleted launchpad/detected-row/fallback paths must not reappear.
        expect(pane).not.toContain('LocalServiceLaunchpad');
        expect(pane).not.toContain('DetectedLocalServiceRow');
        expect(pane).not.toContain('buildLocalServiceLauncherSnapshotFromRows');
        // No inventory-derived fallback launcher state.
        expect(pane).not.toContain('createLocalServiceLauncherState()\n            buildLocalServiceLauncherSnapshotFromRows');
    });

    it('the deleted split-brain surfaces no longer exist', () => {
        expect(exists('sources/components/sessions/localServices/LocalServiceLaunchpad.tsx')).toBe(false);
        expect(exists('sources/components/sessions/localServices/DetectedLocalServiceRow.tsx')).toBe(false);
        expect(exists('sources/sync/domains/local/services/launch/selectors.ts')).toBe(false);
        expect(exists('sources/sync/domains/local/services/inventory/loopbackLaunchTarget.ts')).toBe(false);
    });

    it('launch/index no longer exports the dead launcher-from-rows builder or browser-targets selector', () => {
        const index = read('sources/sync/domains/local/services/launch/index.ts');
        expect(index).not.toContain('buildLocalServiceLauncherSnapshotFromRows');
        expect(index).not.toContain('selectLocalServiceLauncherTargetsForBrowser');
        expect(index).not.toContain('./selectors');
    });

    it('ServiceRowView consumes the neutral surface-copy mapper, with no local reason map', () => {
        const view = read('sources/components/sessions/localServices/ServiceRowView.tsx');
        expect(view).toContain("from '@/sync/domains/surfaces/copy'");
        expect(view).toContain('resolveReasonCopy');
        // No second copy map defined in the services surface.
        expect(view).not.toMatch(/REASON_KEYS\s*=/);
    });

    it('the daemon forms loopback URLs only through the canonical loopbackServiceUrl builder (no hand-concat)', () => {
        // This closure lives in apps/cli; resolve relative to the repo root.
        const cliRoot = path.resolve(UI_ROOT, '../cli');
        const suggestions = readFileSync(
            path.join(cliRoot, 'src/daemon/local/services/launch/suggestions.ts'),
            'utf8',
        );
        expect(suggestions).toContain('function loopbackServiceUrl');
        // No hand-concatenated loopback http(s) URL template outside the builder.
        const handConcat = /`https?:\/\/\$\{[^}]*host[^}]*\}:\$\{[^}]*port[^}]*\}/i;
        const builderBody = suggestions.slice(
            suggestions.indexOf('function loopbackServiceUrl'),
            suggestions.indexOf('function loopbackExternalUrlTarget'),
        );
        const outsideBuilder = suggestions.replace(builderBody, '');
        expect(handConcat.test(outsideBuilder)).toBe(false);
    });
});
