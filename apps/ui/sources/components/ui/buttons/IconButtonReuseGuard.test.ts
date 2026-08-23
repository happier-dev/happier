import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * L0-6 closure: browser chrome and the embedded terminal must not keep local icon-only button
 * wrappers once `IconButton` is the shared owner.
 *
 * G23: this guard used to `continue` past a guarded path that did not exist, so one of its five
 * paths (`components/terminal/embedded/EmbeddedTerminalToolbarIconButton.tsx`, a file that does not
 * exist anywhere in the tree) was silently skipped and the guard still reported green. A guard that
 * passes because it could not find what it guards is worse than no guard. A missing path is now a
 * violation, so a guarded file that moves or is deleted forces the list to be corrected rather than
 * quietly reducing the guard's coverage.
 *
 * It also asserts the positive half — the file still imports the canonical primitive. The
 * name-pinned wrapper regex only catches a re-grown wrapper that happens to reuse one of four old
 * names; dropping `IconButton` for raw `Pressable`s is the same regression and the old guard could
 * not see it.
 */
const LOCAL_ICON_BUTTON_WRAPPER =
    /(?:function|const)\s+(?:ToolbarButton|AutomationIconButton|RecordingButton|DrawerHandleButton|EmbeddedTerminalToolbarIconButton)\b/;

const ICON_BUTTON_IMPORT = "from '@/components/ui/buttons/IconButton'";

/** Files that were migrated onto `IconButton` and must stay on it. */
const GUARDED_PATHS = [
    'components/browser/BrowserToolbar.tsx',
    'components/browser/automation/BrowserAutomationControls.tsx',
    'components/browser/recording/BrowserRecordingControls.tsx',
    'components/browser/diagnostics/BrowserDiagnosticsDrawer.tsx',
    'components/terminal/embedded/EmbeddedTerminalPaneFrame.tsx',
] as const;

export function auditIconButtonReuse(
    sourcesRoot: string,
    relativePaths: readonly string[],
): string[] {
    const violations: string[] = [];

    for (const relativePath of relativePaths) {
        const fullPath = resolve(sourcesRoot, relativePath);
        if (!existsSync(fullPath)) {
            violations.push(`${relativePath}: guarded path does not exist`);
            continue;
        }
        const source = readFileSync(fullPath, 'utf8');
        if (LOCAL_ICON_BUTTON_WRAPPER.test(source)) {
            violations.push(`${relativePath}: declares a local icon-only button wrapper`);
        }
        if (!source.includes(ICON_BUTTON_IMPORT)) {
            violations.push(`${relativePath}: no longer imports the shared IconButton primitive`);
        }
    }

    return violations;
}

describe('IconButton reuse guard', () => {
    const sourcesRoot = resolve(__dirname, '../../..');

    it('keeps browser chrome and embedded-terminal icon-only controls on the shared IconButton primitive', () => {
        expect(auditIconButtonReuse(sourcesRoot, GUARDED_PATHS)).toEqual([]);
    });

    it('fails instead of skipping when a guarded path no longer exists', () => {
        expect(auditIconButtonReuse(sourcesRoot, ['components/browser/ThisFileDoesNotExist.tsx']))
            .toEqual(['components/browser/ThisFileDoesNotExist.tsx: guarded path does not exist']);
    });
});
