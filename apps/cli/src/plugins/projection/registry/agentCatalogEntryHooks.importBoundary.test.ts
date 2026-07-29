import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('agentCatalogEntryHooks import boundaries', () => {
    it('does not import global daemon/session reachability while projecting provider hooks', async () => {
        const source = await readFile(new URL('./agentCatalogEntryHooks.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/from ['"]@\/daemon\/connectedServices\/stateSharing\/canResumeFromMaterializedState['"]/);
        expect(source).not.toMatch(/from ['"]@\/session\/runtime\/control\/reachability['"]/);
        expect(source).not.toMatch(/from ['"]@\/agent\/acp\/runtime\/definition['"]/);
    });

});
