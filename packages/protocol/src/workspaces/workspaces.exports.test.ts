import { describe, expect, it } from 'vitest';

describe('@happier-dev/protocol/workspaces exports', () => {
    it('exports workspace manifest schemas without pulling in handoff RPC schemas', async () => {
        const workspaces = await import('@happier-dev/protocol/workspaces');
        expect(typeof (workspaces as any).WorkspaceManifestSchema?.safeParse).toBe('function');
        expect(typeof (workspaces as any).WorkspaceRefV1Schema?.safeParse).toBe('function');
        expect(typeof (workspaces as any).ProjectKeyV1Schema?.safeParse).toBe('function');
        expect((workspaces as any).WorkspaceManifestEntryKindSchema.parse('file')).toBe('file');
        expect((workspaces as any).SessionHandoffStatusSchema).toBeUndefined();
    }, 30_000);

    it('exports the new modular protocol entrypoints through the package export map', async () => {
        const [sessions, runtime, backends, pets] = await Promise.all([
            import('@happier-dev/protocol/sessions'),
            import('@happier-dev/protocol/runtime'),
            import('@happier-dev/protocol/backends'),
            import('@happier-dev/protocol/pets'),
        ]);

        expect(typeof (sessions as any).SessionIdSchema?.safeParse).toBe('function');
        expect(typeof (runtime as any).RuntimeEventV1Schema?.safeParse).toBe('function');
        expect(typeof (backends as any).BackendExternalSessionsCapabilitiesV1Schema?.safeParse).toBe('function');
        expect((pets as any).PET_ATLAS_V1?.width).toBe(1536);
    }, 30_000);
});
