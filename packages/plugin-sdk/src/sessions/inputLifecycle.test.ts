import { completeSpawnActionResult, settleActionOutput } from '@happier-dev/protocol/actions/executor/resultProjection';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { describe, expect, it } from 'vitest';

import { PluginError } from '../errors.js';
import { projectSessionSpawnNewActionInputV2, SessionServerStartSpawnDraftV1Schema, spawnSessionInputDestinationV1 } from './index.public.js';

const spawn = projectSessionSpawnNewActionInputV2(SessionServerStartSpawnDraftV1Schema.parse({
    executionTarget: { serverId: 'home', machineId: 'machine' },
    directory: { kind: 'path', path: '/workspace/project' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
}));

describe('Session input destination spawn', () => {
    it('returns the native refusal and the Action bridge’s typed cause', async () => {
        const refusal = {
            type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
            launchError: { kind: 'launch_error' as const, code: 'agent_startup_model_reconciliation_failed',
                message: 'Choose a model', failureCause: { phase: 'client_start' as const, failureReason: 'model_selection_required' as const } },
        };
        const bridge = settleActionOutput('session.spawn_new', completeSpawnActionResult(refusal));
        if (bridge.ok) throw new Error('Expected native spawn refusal');
        const error = new PluginError({ code: bridge.errorCode, details: projectNativeJsonValueForTransport(bridge.details),
            failureCause: bridge.failureCause });
        await expect(spawnSessionInputDestinationV1({ spawn, async execute() { throw error; } })).resolves.toEqual({
            ...refusal, failureCause: bridge.failureCause,
        });
    });

    it('returns signed-out Agent recovery without inventing a cause', async () => {
        const details = { type: 'error', code: 'agent_signed_out', retryable: false, agentId: 'codex' } as const;
        const error = new PluginError({ code: details.code, details });
        await expect(spawnSessionInputDestinationV1({ spawn, async execute() { throw error; } })).resolves.toEqual(details);
    });

    it.each([
        { type: 'error', code: 'agent_signed_out', retryable: false },
        { type: 'error', code: 'target_required', retryable: false },
        { type: 'pending', outcome: 'unknown', retryWithSameCreationKey: true },
    ])('leaves invalid or mismatched settlement details with the original throw', async details => {
        const error = new PluginError({ code: 'agent_signed_out', details });
        await expect(spawnSessionInputDestinationV1({ spawn, async execute() { throw error; } })).rejects.toBe(error);
    });
});
