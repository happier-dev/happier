import { describe, expect, it } from 'vitest';

describe('@happier-dev/protocol/workspaces exports', () => {
    it('exports workspace manifest schemas without pulling in handoff RPC schemas', async () => {
        const workspaces = await import('@happier-dev/protocol/workspaces');
        expect(typeof (workspaces as any).WorkspaceManifestSchema?.safeParse).toBe('function');
        expect((workspaces as any).WorkspaceManifestEntryKindSchema.parse('file')).toBe('file');
        expect((workspaces as any).SessionHandoffStatusSchema).toBeUndefined();
    }, 30_000);
});
