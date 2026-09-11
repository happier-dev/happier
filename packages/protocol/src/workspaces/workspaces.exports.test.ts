import { describe, expect, it } from 'vitest';

import * as pets from '@happier-dev/protocol/pets';
import * as runtime from '@happier-dev/protocol/runtime';
import * as sessions from '@happier-dev/protocol/sessions';
import * as spawnSession from '@happier-dev/protocol/spawnSession';
import * as transferRelayV2 from '@happier-dev/protocol/transferRelayV2';
import * as transferSessions from '@happier-dev/protocol/transferSessions';
import * as workspaces from '@happier-dev/protocol/workspaces';

describe('@happier-dev/protocol/workspaces exports', () => {
    it('exports workspace manifest schemas without pulling in handoff RPC schemas', () => {
        expect(typeof (workspaces as any).WorkspaceManifestSchema?.safeParse).toBe('function');
        expect(typeof (workspaces as any).WorkspaceRefV1Schema?.safeParse).toBe('function');
        expect(typeof (workspaces as any).ProjectKeyV1Schema?.safeParse).toBe('function');
        expect((workspaces as any).WorkspaceManifestEntryKindSchema.parse('file')).toBe('file');
        expect((workspaces as any).SessionHandoffStatusSchema).toBeUndefined();
    });

    it('exports the new modular protocol entrypoints through the package export map', () => {
        expect(typeof (sessions as any).SessionIdSchema?.safeParse).toBe('function');
        expect(typeof (runtime as any).AgentSessionRuntimeEventV1Schema?.safeParse).toBe('function');
        expect((pets as any).PET_ATLAS_V1?.width).toBe(1536);
        expect(typeof (spawnSession as any).SpawnSessionErrorCodeSchema?.safeParse).toBe('function');
        expect(typeof (transferRelayV2 as any).TransferRelayV2EnvelopeSchema?.safeParse).toBe('function');
        expect(typeof (transferSessions as any).TransferSessionChunkEnvelopeSchema?.safeParse).toBe('function');
    });
});
