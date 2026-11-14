import { expect, it } from 'vitest';
import { MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

import { prepareMachineSetupPresetApplyInput } from './machineSetupApply';

it('projects a saved preset to the opaque Plan source without sending its opened setup', async () => {
    const setup = { scripts: [{ body: 'private setup body' }] };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0,
        sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [] });
    const requests: unknown[] = [];
    // Home Action execution is the transport boundary; the Plan/input schemas and preparation path stay real.
    const executeAction = async (_actionId: unknown, input: unknown) => {
        const request = MachineSetupPlanInputV1Schema.parse(input);
        requests.push(request);
        return { ok: true as const, result: request.mode
            ? { ...current, sources: request.sources, recipePlans: [] }
            : current };
    };

    const prepared = await prepareMachineSetupPresetApplyInput({ executeAction: executeAction as never,
        context: { surface: 'ui' }, homeId: 'home', machineId: 'machine', isCurrent: () => true,
        preset: { id: 'saved', revision: 3, contentEncryptionMode: 'plain', setup } });

    expect(prepared).toMatchObject({ ok: true, input: { targets: [{ sources: [
        { kind: 'accountPresetOpaque', presetId: 'saved', presetRevision: 3, contentEncryptionMode: 'plain' },
        { kind: 'direct', setup: {} },
    ] }] } });
    expect(requests[1]).not.toMatchObject({ sources: [expect.objectContaining({ setup })] });
});
