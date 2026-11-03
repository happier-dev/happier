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
    type SessionMessageProvenanceV1 as CanonicalSessionMessageProvenanceV1,
} from '@happier-dev/protocol/sessions/general';
import {
    SessionAuthoringCheckoutCreationDraftV1Schema as canonicalSessionAuthoringCheckoutCreationDraftV1Schema,
    SessionSpawnNewInputV2Schema as canonicalSessionSpawnNewInputV2Schema,
    SessionServerStartSpawnDraftV1Schema as canonicalSessionServerStartSpawnDraftV1Schema,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type {
    SessionAuthoringCheckoutCreationDraftV1 as CanonicalSessionAuthoringCheckoutCreationDraftV1,
    SessionSpawnNewInputV2 as CanonicalSessionSpawnNewInputV2,
    SessionServerStartSpawnDraftV1 as CanonicalSessionServerStartSpawnDraftV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import * as root from '../index.js';
import * as sessions from './index.js';
import * as publicSessions from './index.public.js';
import type {
    AgentPermissionIntentV1 as PublicAgentPermissionIntentV1,
    SessionId as PublicSessionId,
    SessionAuthoringCheckoutCreationDraftV1 as PublicSessionAuthoringCheckoutCreationDraftV1,
    SessionMessageProvenanceV1 as PublicSessionMessageProvenanceV1,
    SessionServerStartSpawnDraftV1 as PublicSessionServerStartSpawnDraftV1,
    SessionSpawnNewInputV2 as PublicSessionSpawnNewInputV2,
} from './index.js';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';

describe('Session input canonical SDK projections', () => {
    it('projects native Session creation placement into public Action input', () => {
        const input = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            organizationPlacement: { folderId: 'section-1', tagIds: ['tag-1'] },
        };
        const native = publicSessions.SessionSpawnNewInputV2Schema.parse(input);
        const action = publicSessions.projectSessionSpawnNewActionInputV2(native);
        expect(action).toEqual({ ...input, organizationPlacement: { sectionId: 'section-1', tagIds: ['tag-1'] } });
        expect(native).toEqual(input);
        expect(sessions.projectSessionSpawnNewActionInputV2).toBe(publicSessions.projectSessionSpawnNewActionInputV2);
    });
    it('reads native mode facts and fails closed on malformed current metadata through /sessions', () => {
        expect(publicSessions.readSessionModesMetadata).toBeTypeOf('function');
        const current = {
            v: 2, agentId: 'codex', updatedAt: 2, currentModeId: null,
            availableModes: [{ id: 'workspace-write', name: 'Workspace write' }],
        };
        expect(publicSessions.readSessionModesMetadata({ sessionModesV2: current }))
            .toMatchObject({ currentModeId: null, availableModes: current.availableModes });
        expect(publicSessions.readSessionModesMetadata({
            sessionModesV2: { ...current, availableModes: 'malformed' },
            sessionModesV1: { v: 1, agentId: 'codex', updatedAt: 1,
                currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        })).toBeNull();
    });
    it('re-exports the canonical Session input values by identity only through /sessions', () => {
        expect(sessions.SessionIdSchema).toBe(canonicalSessionIdSchema);
        expect(sessions.SessionIndexedIdentifierMaxLengthV1)
            .toBe(SessionIndexedIdentifierMaxLengthV1);
        expect(sessions.AgentPermissionIntentV1Schema)
            .toBe(AgentPermissionIntentV1Schema);
        expect(sessions.SessionAuthoringCheckoutCreationDraftV1Schema)
            .toBe(canonicalSessionAuthoringCheckoutCreationDraftV1Schema);
        expect(sessions.SessionSpawnNewInputV2Schema)
            .toBe(canonicalSessionSpawnNewInputV2Schema);
        expect(sessions.SessionServerStartSpawnDraftV1Schema)
            .toBe(canonicalSessionServerStartSpawnDraftV1Schema);
        expect('SessionIdSchema' in root).toBe(false);
        expect('SessionIndexedIdentifierMaxLengthV1' in root).toBe(false);
        expect('AgentPermissionIntentV1Schema' in root).toBe(false);
        expect('SessionAuthoringCheckoutCreationDraftV1Schema' in root).toBe(false);
        expect('SessionSpawnNewInputV2Schema' in root).toBe(false);
        expect('SessionServerStartSpawnDraftV1Schema' in root).toBe(false);

        const validSpawnInput = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
        } as const;
        const checkoutCreationDraft = {
            kind: 'git_worktree',
            displayName: 'feature/session-create',
            baseRef: 'main',
            branchMode: 'new',
        } as const;
        expect(sessions.SessionAuthoringCheckoutCreationDraftV1Schema
            .safeParse(checkoutCreationDraft).success).toBe(true);
        expect(sessions.SessionAuthoringCheckoutCreationDraftV1Schema.safeParse({
            ...checkoutCreationDraft,
            unexpected: true,
        }).success).toBe(false);
        expect(sessions.SessionSpawnNewInputV2Schema.safeParse(validSpawnInput).success).toBe(true);
        expect(sessions.SessionSpawnNewInputV2Schema.parse({
            ...validSpawnInput,
            checkoutCreationDraft,
        }).checkoutCreationDraft).toEqual(checkoutCreationDraft);
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
        expectTypeOf<PublicSessionAuthoringCheckoutCreationDraftV1>()
            .toEqualTypeOf<CanonicalSessionAuthoringCheckoutCreationDraftV1>();
        expectTypeOf<NonNullable<PublicSessionSpawnNewInputV2['checkoutCreationDraft']>>()
            .toEqualTypeOf<CanonicalSessionAuthoringCheckoutCreationDraftV1>();
        expectTypeOf<CanonicalSessionSpawnNewInputV2>()
            .toMatchTypeOf<PublicSessionSpawnNewInputV2>();
        expectTypeOf<CanonicalSessionServerStartSpawnDraftV1>()
            .toMatchTypeOf<PublicSessionServerStartSpawnDraftV1>();
        expectTypeOf<CanonicalSessionMessageProvenanceV1>()
            .toEqualTypeOf<PublicSessionMessageProvenanceV1>();
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
        expect(emitted.outputText).toContain(
            'SessionAuthoringCheckoutCreationDraftV1Schema: SessionSchema<SessionAuthoringCheckoutCreationDraftV1>;',
        );
        expect(emitted.outputText).toContain('SessionIdSchema: ProtocolComposableSchema<SessionId>;');
    });
});


describe('Session structured-question SDK projections', () => {
    it('preserves live answer keys, choice values and custom-input semantics through the public question projection', () => {
        expect(publicSessions.summarizeAgentRequestQuestions([
            {
                id: ' scope ', header: ' Scope ', question: ' Choose scope ', multiple: true, required: false,
                options: [{ id: 'session', label: ' This session ', description: ' Reuse during this session ' }],
                freeform: { description: ' Explain another scope ', placeholder: ' Your scope ' },
            },
            { header: ' Note ', selection: 'text' },
            { question: '   ' },
        ])).toEqual([
            {
                answerKey: 'scope', header: 'Scope', question: 'Choose scope', selection: 'multiple',
                required: false, allowCustom: true,
                choices: [{ value: 'session', label: 'This session', description: 'Reuse during this session' }],
                freeformDescription: 'Explain another scope', freeformPlaceholder: 'Your scope',
            },
            {
                answerKey: 'Note', header: 'Note', question: 'Note', selection: 'text',
                required: true, allowCustom: true, choices: [],
            },
        ]);
    });

    it('validates lossless answer arrays and rejects ambiguous or duplicate answers through the public schema', () => {
        const parsed = publicSessions.StructuredQuestionAnswersV1Schema.parse({
            scope: ['value, with comma', 'freeform\nanswer'],
        });
        expect(parsed.scope).toEqual(['value, with comma', 'freeform\nanswer']);
        expect(Object.getPrototypeOf(parsed)).toBeNull();
        expect(Object.isFrozen(parsed.scope)).toBe(true);
        expect(publicSessions.StructuredQuestionAnswersV1Schema.safeParse({ scope: 'legacy, joined' }).success).toBe(false);
        expect(publicSessions.StructuredQuestionAnswersV1Schema.safeParse({ scope: ['same', 'same'] }).success).toBe(false);
    });
});
