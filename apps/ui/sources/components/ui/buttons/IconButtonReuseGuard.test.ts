import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * L0-6 closure: browser chrome must not keep local icon-only button wrappers
 * once `IconButton` is the shared owner.
 */
describe('IconButton reuse guard', () => {
    it('keeps browser chrome icon-only controls on the shared IconButton primitive', () => {
        const sourcesRoot = resolve(__dirname, '../../..');
        const files = [
            'components/browser/BrowserToolbar.tsx',
            'components/browser/automation/BrowserAutomationControls.tsx',
            'components/browser/recording/BrowserRecordingControls.tsx',
            'components/browser/diagnostics/BrowserDiagnosticsDrawer.tsx',
            'components/terminal/embedded/EmbeddedTerminalToolbarIconButton.tsx',
        ];
        const violations: string[] = [];

        for (const relativePath of files) {
            const fullPath = resolve(sourcesRoot, relativePath);
            if (!existsSync(fullPath)) {
                continue;
            }
            const source = readFileSync(fullPath, 'utf8');
            if (
                /function\s+(ToolbarButton|AutomationIconButton|RecordingButton|DrawerHandleButton)\b/.test(source)
                || /EmbeddedTerminalToolbarIconButton\s*=\s*React\.memo/.test(source)
            ) {
                violations.push(relativePath);
            }
        }

        expect(violations).toEqual([]);
    });
});
