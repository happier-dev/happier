import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SessionCreationKeyV1Schema,
    type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';

const frontDoorExecute = vi.hoisted(() => vi.fn());

vi.mock('./frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => frontDoorExecute,
}));

import {
    executeSessionSpawnNewAction,
    type StrictSessionSpawnNewInput,
} from './sessionSpawnNewAction';

const input: StrictSessionSpawnNewInput = {
    creationKey: SessionCreationKeyV1Schema.parse('new-session-attempt-1'),
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    directory: '/work/project',
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier', localId: 'codex' } },
};

const result: SessionSpawnNewResultV1 = {
    type: 'success',
    disposition: 'created',
    sessionId: 'session-created',
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    organizationPlacement: { folderId: null, tagIds: [] },
    initialInput: { status: 'notRequested' },
};

beforeEach(() => frontDoorExecute.mockReset());

describe('executeSessionSpawnNewAction tracking', () => {
    it('uses the historical Action front door exactly once and preserves its terminal result', async () => {
        frontDoorExecute.mockResolvedValue({ ok: true, result });

        await expect(executeSessionSpawnNewAction(input, {
            surface: 'ui',
            actionRequestId: input.creationKey,
        })).resolves.toEqual({ ok: true, result });

        expect(frontDoorExecute).toHaveBeenCalledTimes(1);
        expect(frontDoorExecute).toHaveBeenCalledWith('session.spawn_new', input, {
            surface: 'ui',
            actionRequestId: input.creationKey,
        });
    });

    it('preserves the historical typed failure without issuing another execution path', async () => {
        frontDoorExecute.mockResolvedValue({
            ok: false,
            errorCode: 'target_unavailable',
            error: 'Target unavailable',
        });

        await expect(executeSessionSpawnNewAction(input, {
            surface: 'ui',
            actionRequestId: input.creationKey,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'target_unavailable',
            error: 'Target unavailable',
        });
        expect(frontDoorExecute).toHaveBeenCalledTimes(1);
    });
});
