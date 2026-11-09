import { describe, expect, it } from 'vitest';
import type { ServerFetch } from '@/sync/http/client';
import { executeApiTokenAction } from './apiTokenActionTransport';
import { applyComposerControlAcknowledgementV1 } from '@happier-dev/protocol/embed';
import { ExternalActionRequestEnvelopeV1Schema, projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { PUBLIC_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { API_TOKEN_FULL_GRANT_V1, evaluateApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createSessionFixture } from '@/dev/testkit';
import { buildLiveSessionAuthoringContext } from '@/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import { resolveSessionComposerState } from '@/components/sessions/authoring/context/resolveSessionComposerState';

describe('API-token Action transport', () => {
    it('preserves the Machine availability cause and remedy without adopting unrelated diagnostics', async () => {
        const diagnostic = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
        const request: ServerFetch = async () => Response.json({ error: 'invalid_request', code: 'target_unavailable', diagnostic }, { status: 409 });
        expect(await executeApiTokenAction({ request }, 'session.stop', { sessionId: 'session-1' }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: diagnostic });
        const malformed: ServerFetch = async () => Response.json({ error: 'invalid_request', code: 'target_unavailable',
            diagnostic: { ...diagnostic, message: 'private' } }, { status: 409 });
        expect(await executeApiTokenAction({ request: malformed }, 'session.stop', { sessionId: 'session-1' }))
            .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });
    it('retains a typed RPC refusal while keeping the Action outcome uncertain', async () => {
        const diagnostic = { reason: 'daemon_rpc_refused', errorCode: 'RPC_FORBIDDEN' };
        const request: ServerFetch = async (_path, init) => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            return Response.json({ error: 'invalid_request', code: 'action_outcome_unknown',
                ...(envelope.requestId ? { requestId: envelope.requestId } : {}), diagnostic }, { status: 502 });
        };
        expect(await executeApiTokenAction({ request }, 'session.stop', { sessionId: 'session-1' }))
            .toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', details: { diagnostic } });
    });
    it('keeps the owner composer model precedence unchanged outside the frame', () => {
        const metadata = { path: '/', host: '', flavor: 'codex' as const };
        const session = createSessionFixture({ metadataLayoutVersion: 1, metadata, ownerMetadataView: metadata,
            composerOptionsInput: { modelOverrideV1: { v: 1, modelId: 'stored-model', updatedAt: 1 } } });
        expect(resolveSessionComposerState({ session, snapshot: { agentId: 'codex', permissionMode: 'default',
            modelId: 'current-owner-selection', profileId: null, directory: '/' } }).modelMode).toBe('current-owner-selection');
    });
    it.each(['session.permission_mode.set', 'session.model.set'] as const)('projects %s only after the server acknowledges its value', async (actionId) => {
        let session = createSessionFixture({ id: 'session-1', metadataLayoutVersion: 1, ownerMetadataView: null,
            metadata: { path: '/', host: '', flavor: 'codex' }, composerOptionsInput: {} });
        const label = () => resolveSessionComposerStateFromAuthoringContext(
            buildLiveSessionAuthoringContext({ session }), { fallbackAgentId: 'codex' },
        );
        let finish!: (response: Response) => void;
        const response = new Promise<Response>(resolve => { finish = resolve; });
        const request: ServerFetch = async () => response;
        const transport = { request, target: { kind: 'session' as const, sessionId: session.id },
            onActionAcknowledged: (id: string, result: unknown) => {
                session = { ...session, composerOptionsInput: applyComposerControlAcknowledgementV1({
                    sessionId: session.id, options: session.composerOptionsInput ?? {}, actionId: id, result,
                }) };
            } };
        const permission = actionId === 'session.permission_mode.set';
        const operation = executeApiTokenAction(transport, actionId, { sessionId: session.id,
            ...(permission ? { permissionMode: 'read_only' } : { modelId: 'acknowledged-model' }),
        }, { surface: 'ui' });
        expect(label().permissionMode).toBe('default');
        expect(label().modelMode).toBe('default');
        finish(Response.json({ v: 1, actionId, execution: { ok: true, result: { ok: true, sessionId: session.id,
            updatedAt: 321, ...(permission ? { permissionMode: 'read-only' } : { status: 'intent_updated',
                modelId: 'acknowledged-model', selection: { agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null, modelId: 'acknowledged-model' } }),
        } } }));
        expect((await operation).ok).toBe(true);
        expect(permission ? label().permissionMode : label().modelMode).toBe(permission ? 'read-only' : 'acknowledged-model');
        expect(session.ownerMetadataView).toBeNull();
    });

    it('does not publish a failed control change', async () => {
        let acknowledgements = 0;
        const transport = { request: (async () => Response.json({ v: 1, actionId: 'session.permission_mode.set',
            execution: { ok: false, errorCode: 'permission_mode_not_granted', error: 'permission_mode_not_granted' },
        })) satisfies ServerFetch, onActionAcknowledged: () => { acknowledgements += 1; } };
        expect(await executeApiTokenAction(transport, 'session.permission_mode.set', {
            sessionId: 'session-1', permissionMode: 'read-only',
        })).toMatchObject({ ok: false, errorCode: 'permission_mode_not_granted' });
        expect(acknowledgements).toBe(0);
    });

    it('refuses next-prompt mode with Send guidance before requesting the Home', async () => {
        const request: ServerFetch = async () => { throw new Error('Refused timing must not reach the Home'); };
        expect(await executeApiTokenAction({ request }, 'session.permission_mode.set', {
            sessionId: 'session-1', permissionMode: 'read_only', applyTiming: 'next_prompt',
        }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters', error: expect.stringContaining('session.message.send') });
    });
    it('uses the canonical spawn public projection without adding a CORS authority header', async () => {
        let body: unknown;
        let ceiling: string | null = null;
        const request: ServerFetch = async (_path, init) => {
            body = JSON.parse(String(init?.body));
            ceiling = new Headers(init?.headers).get('x-happier-authority-ceiling');
            return new Response(JSON.stringify({ v: 1, actionId: 'session.spawn_new', execution: { ok: true, result: {
                type: 'success', disposition: 'created', sessionId: 'session-1',
                executionTarget: { serverId: 'home', machineId: 'machine' },
                organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
            } } }));
        };
        const result = await executeApiTokenAction({ request }, 'session.spawn_new', {
            creationKey: '00000000-0000-4000-8000-000000000001',
            executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        }, { surface: 'ui', authority: 'present_user' });
        expect(result.ok).toBe(true);
        expect(ceiling).toBeNull();
        expect(body).toMatchObject({ v: 1, target: { kind: 'machine', machineId: 'machine' }, input: { directory: { kind: 'managed' } } });
        expect(body).not.toHaveProperty('input.executionTarget');
        expect(body).not.toHaveProperty('authority');
    });
    it.each([
        { actionId: 'session.open', input: { sessionId: 'session-1', intent: 'resume' } },
        { actionId: 'session.message.send', input: { sessionId: 'session-1', message: 'Continue this conversation' } },
        { actionId: 'teams.list', input: PUBLIC_ACTION_INPUT_SCHEMAS['teams.list'].parse({ v: 1, scope: 'member', archived: 'active' }) },
        { actionId: 'discussion.list', input: {} },
    ] as const)('preserves current credential refusals for $actionId without retries or acknowledgement', async ({ actionId, input }) => {
        for (const condition of ['wrong-session', 'not-granted', 'revoked'] as const) {
            let requests = 0;
            let acknowledgements = 0;
            const code = condition === 'revoked' ? 'invalid_token' : 'credential_scope_denied';
            const grant = { ...API_TOKEN_FULL_GRANT_V1,
                ...(condition === 'wrong-session' ? { targets: { sessions: ['session-2'], machines: [] } } : {}),
                ...(condition === 'not-granted' ? { actions: { families: [], ids: [] } } : {}),
            };
            const request: ServerFetch = async (_path, init, options) => {
                requests += 1;
                expect(options?.retry).toBe('none');
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                if (condition !== 'revoked') expect(evaluateApiTokenGrantV1({ grant, actionId, target: envelope.target }).ok).toBe(false);
                const projected = projectExternalActionHttpError(code);
                return Response.json(projected.payload, { status: projected.statusCode });
            };
            expect(await executeApiTokenAction({ request, target: { kind: 'session', sessionId: 'session-1' },
                onActionAcknowledged: () => { acknowledgements += 1; } }, actionId, input,
            )).toEqual({ ok: false, errorCode: code, error: code });
            expect(requests).toBe(1);
            expect(acknowledgements).toBe(0);
        }
    });

    it('rejects malformed HTTP refusals without disclosing unvalidated producer text', async () => {
        const request: ServerFetch = async () => Response.json({ error: 'private unvalidated error' }, { status: 403 });
        expect(await executeApiTokenAction({ request }, 'session.open', { sessionId: 'session-1', intent: 'resume' }))
            .toEqual({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
    });

    it('refuses an Action response for another Action', async () => {
        const request: ServerFetch = async () => new Response(JSON.stringify({ v: 1, actionId: 'session.message.send', execution: { ok: true, result: {} } }));
        const result = await executeApiTokenAction({ request }, 'action.options.resolve', { actionId: 'session.spawn_new', fieldPath: 'modelSelection' }, { surface: 'ui' });
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });
});
