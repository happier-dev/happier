import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * DV-PLATFORM-CLOSURE (OWNER-PLATFORM): a production browser mount/open path must resolve its
 * platform through the one Tauri-aware {@link resolveBrowserSurfacePlatform} resolver — NEVER via a
 * `platform ?? 'web'` (or `?? "web"`) fallback, which silently misclassifies desktop as web (the
 * literal mechanism of B-RC1). This test FAILS if any browser mount/open site re-introduces such a
 * fallback.
 *
 * Scope is the browser mount/open factory sites verified in the packet (§3.1). The plugin surface
 * `PluginSurfaceHost.tsx` is explicitly EXCLUDED: it consumes `LocalServicePreviewPlatform`, not a
 * browser mount, so its `?? 'web'` is legitimate.
 */
const SOURCES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const BROWSER_MOUNT_OPEN_SITES: readonly string[] = [
    'components/sessions/panes/surfaces/sessionDetailsSurfaceRenderers.tsx',
    'components/projects/panes/details/surfaces/workspaceDetailsSurfaceRenderers.tsx',
    'components/sessions/panes/SessionDetailsPanel.tsx',
    'components/browser/surfaces/openBrowserTargetInWorkspace.ts',
    'components/browser/surfaces/useBrowserSurfaceHostProps.ts',
];

const PLATFORM_WEB_FALLBACK = /platform\s*\?\?\s*['"]web['"]/;

describe('DV-PLATFORM-CLOSURE: no `platform ?? "web"` fallback on browser mount/open paths', () => {
    for (const relativePath of BROWSER_MOUNT_OPEN_SITES) {
        it(`does not default platform to 'web' in ${relativePath}`, () => {
            const source = readFileSync(join(SOURCES_ROOT, relativePath), 'utf8');
            expect(PLATFORM_WEB_FALLBACK.test(source)).toBe(false);
        });
    }
});
