import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../../../..');

const forbiddenUiOperationNames = [
    'sessionStopWithServerScope',
    'sessionArchiveWithServerScope',
    'sessionUnarchiveWithServerScope',
    'sessionRename',
    'sessionSetManualReadStateWithServerScope',
    'sessionDelete',
    'sessionDeleteWithServerScope',
    'stopSessionAndMaybeArchive',
] as const;

function containsDirectOperationWiring(source: string, operationName: string): boolean {
    const escaped = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`import\\s+\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s+from\\s+['"]@/sync/ops['"]`, 'u').test(source)
        || new RegExp(`import\\s+\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s+from\\s+['"][^'"]*sessionStopArchiveFlow['"]`, 'u').test(source)
        || new RegExp(`\\b${escaped}\\s*\\(`, 'u').test(source);
}

describe('session action wiring', () => {
    it.each([
        'apps/ui/sources/components/sessions/shell/SessionItem.tsx',
        'apps/ui/sources/app/(app)/session/[id]/info.tsx',
        'apps/ui/sources/components/sessions/actions/SessionHeaderActionMenu.tsx',
    ])('%s delegates session mutations through the session action module', (relativePath) => {
        const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
        for (const operationName of forbiddenUiOperationNames) {
            expect(containsDirectOperationWiring(source, operationName), `${relativePath} should not call or import ${operationName} directly`).toBe(false);
        }
    });
});
