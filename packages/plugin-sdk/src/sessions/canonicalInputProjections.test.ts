import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import {
    SessionIdSchema as canonicalSessionIdSchema,
    SessionIndexedIdentifierMaxLengthV1,
    type SessionId as CanonicalSessionId,
} from '@happier-dev/protocol/sessions';
import {
    AgentPermissionIntentV1Schema,
    type AgentPermissionIntentV1 as CanonicalAgentPermissionIntentV1,
} from '@happier-dev/protocol/sessions/general';
import {
    SessionSpawnNewInputV2Schema as canonicalSessionSpawnNewInputV2Schema,
    SessionServerStartSpawnDraftV1Schema as canonicalSessionServerStartSpawnDraftV1Schema,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type {
    SessionSpawnNewInputV2 as CanonicalSessionSpawnNewInputV2,
    SessionServerStartSpawnDraftV1 as CanonicalSessionServerStartSpawnDraftV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import * as root from '../index.js';
import * as sessions from './index.js';
import type {
    AgentPermissionIntentV1 as PublicAgentPermissionIntentV1,
    SessionId as PublicSessionId,
    SessionServerStartSpawnDraftV1 as PublicSessionServerStartSpawnDraftV1,
    SessionSpawnNewInputV2 as PublicSessionSpawnNewInputV2,
} from './index.js';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';

describe('Session input canonical SDK projections', () => {
    it('re-exports the canonical Session input values by identity only through /sessions', () => {
        expect(sessions.SessionIdSchema).toBe(canonicalSessionIdSchema);
        expect(sessions.SessionIndexedIdentifierMaxLengthV1)
            .toBe(SessionIndexedIdentifierMaxLengthV1);
        expect(sessions.AgentPermissionIntentV1Schema)
            .toBe(AgentPermissionIntentV1Schema);
        expect(sessions.SessionSpawnNewInputV2Schema)
            .toBe(canonicalSessionSpawnNewInputV2Schema);
        expect(sessions.SessionServerStartSpawnDraftV1Schema)
            .toBe(canonicalSessionServerStartSpawnDraftV1Schema);
        expect('SessionIdSchema' in root).toBe(false);
        expect('SessionIndexedIdentifierMaxLengthV1' in root).toBe(false);
        expect('AgentPermissionIntentV1Schema' in root).toBe(false);
        expect('SessionSpawnNewInputV2Schema' in root).toBe(false);
        expect('SessionServerStartSpawnDraftV1Schema' in root).toBe(false);

        const validSpawnInput = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace/project',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
        } as const;
        expect(sessions.SessionSpawnNewInputV2Schema.safeParse(validSpawnInput).success).toBe(true);
        expect(sessions.SessionSpawnNewInputV2Schema.safeParse({
            ...validSpawnInput,
            unexpected: true,
        }).success).toBe(false);
        expect(sessions.SessionServerStartSpawnDraftV1Schema.parse(validSpawnInput))
            .toEqual(validSpawnInput);
        expect(sessions.SessionServerStartSpawnDraftV1Schema.safeParse({
            ...validSpawnInput,
            creationKey: 'host-owned',
        }).success).toBe(false);
    });

    it('projects canonical Session input types through the SDK author surface', () => {
        expectTypeOf<PublicSessionId>().toEqualTypeOf<CanonicalSessionId>();
        expectTypeOf<PublicAgentPermissionIntentV1>()
            .toEqualTypeOf<CanonicalAgentPermissionIntentV1>();
        expectTypeOf<CanonicalSessionSpawnNewInputV2>()
            .toMatchTypeOf<PublicSessionSpawnNewInputV2>();
        expectTypeOf<CanonicalSessionServerStartSpawnDraftV1>()
            .toMatchTypeOf<PublicSessionServerStartSpawnDraftV1>();
        expectTypeOf<typeof sessions.SessionIdSchema>()
            .toEqualTypeOf<ProtocolComposableSchema<PublicSessionId>>();
        expectTypeOf<typeof sessions.AgentPermissionIntentV1Schema>()
            .toEqualTypeOf<ProtocolComposableSchema<PublicAgentPermissionIntentV1>>();
    });

    it('publishes Session identity roots as composable SDK projections', async () => {
        const sourceText = await readFile(new URL('../services/sessions.ts', import.meta.url), 'utf8');
        const emitted = ts.transpileDeclaration(sourceText, {
            fileName: 'services/sessions.ts',
            compilerOptions: {
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                target: ts.ScriptTarget.ES2022,
            },
            reportDiagnostics: true,
        });

        expect(emitted.diagnostics).toEqual([]);
        expect(emitted.outputText).toContain(
            'AgentPermissionIntentV1Schema: ProtocolComposableSchema<AgentPermissionIntentV1>;',
        );
        expect(emitted.outputText).toContain('SessionIdSchema: ProtocolComposableSchema<SessionId>;');
    });
});
