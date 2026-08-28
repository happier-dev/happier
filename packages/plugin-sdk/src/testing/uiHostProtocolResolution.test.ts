import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const workspaceRequire = createRequire(new URL('../../package.json', import.meta.url));

describe('Plugin UI testkit Protocol resolution', () => {
    it('uses only Protocol specifiers admitted by the package export map', async () => {
        const source = await readFile(new URL('./uiHost.ts', import.meta.url), 'utf8');
        const protocolSpecifiers = ts.preProcessFile(source, true, true).importedFiles
            .map(({ fileName }) => fileName)
            .filter((specifier) => (
                specifier === '@happier-dev/protocol'
                || specifier.startsWith('@happier-dev/protocol/')
            ));

        expect(protocolSpecifiers).toContain('@happier-dev/protocol/plugins/ui');
        for (const specifier of protocolSpecifiers) {
            expect(() => workspaceRequire.resolve(specifier), specifier).not.toThrow();
        }
    });
});
