import { expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/protocol';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineControllerError, ManagedMachineNativeRefusal } from './controllerErrors.js';
import { settleManagedMachineDeleteIntent } from './destroy.js';

it.each([false, true])('preserves unknown Delete diagnostics without overriding confirmed absence (report rejected=%s)', async rejected => {
    const machine = ManagedMachineFullV1Schema.parse({
        id: 'retained', homeId: 'home', custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
        resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
        allocation: 'bound', creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    });
    const nativeCause = { localCause: 'native_command_failed', command: 'delete', exitCode: 1,
        stderr: 'Native command failed for [redacted]' } as const;
    const reportError = new ManagedMachineControllerError('invalid-params', 400);
    const warnings: unknown[] = [];
    const settled = { ...machine, allocation: 'confirmed-absent' as const };
    const work = settleManagedMachineDeleteIntent({ machine,
        // The contributed native Action and Home report are external boundaries.
        invoke: async (role): Promise<JsonValue> => role === 'destroy'
            ? { kind: 'unknown', code: 'native_command_failed', nativeCause }
            : { observedAt: 2, availability: 'absent' },
        report: async deletion => {
            expect(deletion).toMatchObject({ result: { kind: 'unknown', code: 'native_command_failed', nativeCause },
                observation: { availability: 'absent' } });
            if (rejected) throw reportError;
            return settled;
        },
        onNativeFailureReportError: error => { warnings.push(error); },
    });
    if (rejected) {
        const error = await work.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(ManagedMachineControllerError);
        expect(error).not.toBeInstanceOf(ManagedMachineNativeRefusal);
        expect(error).toMatchObject({ code: 'native_command_failed', details: { kind: 'managedNative', nativeCause } });
        expect(warnings).toEqual([reportError]);
    } else {
        await expect(work).resolves.toBe(settled);
        expect(warnings).toEqual([]);
    }
});
