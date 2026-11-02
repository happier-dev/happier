import { describe, expect, it } from 'vitest';
import * as contract from './machineSecretGrantV1.js';

describe('MachineSecretGrantV1', () => {
    it('admits only closed, installation-bound subjects without an Environment epoch', () => {
        const base = { v: 1, machineId: 'machine', installationId: 'installation', sealedContent: 'opaque' };
        const subjects = [
            { kind: 'secret', environmentId: 'environment', resourceId: 'resource', resourceRevision: 3 },
            { kind: 'environmentValues', environmentId: 'environment', binding: { purpose: 'variable', phase: 'runtime', name: 'PORT' } },
            { kind: 'connectorToken', provider: { pluginId: 'example.tunnel', localId: 'tunnel' }, connectorId: 'connector' },
            { kind: 'connectorToken', provider: { kind: 'builtin', id: 'tailscale' }, connectorId: 'connector' },
            { kind: 'connectorToken', provider: { kind: 'builtin', id: 'cloudflare' }, connectorId: 'connector' },
        ];
        for (const subject of subjects) {
            const grant = { ...base, ...subject };
            expect(contract.MachineSecretGrantV1Schema.safeParse(grant).success).toBe(true);
            expect(contract.MachineSecretGrantV1Schema.safeParse({ ...grant, environmentRevision: 9 }).success).toBe(false);
            expect(contract.MachineSecretGrantV1Schema.safeParse({ ...grant, installationId: '' }).success).toBe(false);
            const admitted = contract.MachineSecretGrantSubjectV1Schema.parse({ v: 1, machineId: 'machine', installationId: 'installation', ...subject });
            const ref = contract.machineSecretGrantSubjectKey(admitted);
            expect(contract.parseMachineSecretGrantSubjectKey(ref)).toEqual(admitted);
            expect(contract.parseMachineSecretGrantSubjectKey(ref.slice(0, -1) + ',"extra"]')).toBeNull();
            expect(contract.parseMachineSecretGrantSubjectKey(' ' + ref)).toBeNull();
        }
        for (const invalid of ['grant-a', '{}', '[1,"unknown","machine","installation"]', '[2,"connectorToken","machine","installation","p","c","id"]']) {
            expect(contract.parseMachineSecretGrantSubjectKey(invalid)).toBeNull();
        }
        expect(contract.MachineSecretGrantV1Schema.safeParse({ ...base, ...subjects[0], resourceRevision: 0 }).success).toBe(false);
        expect(contract.MachineSecretGrantV1Schema.safeParse({ ...base, ...subjects[1], binding: { purpose: 'variable', phase: 'runtime', name: 'PORT', source: {} } }).success).toBe(false);
        expect(contract.MachineSecretGrantV1Schema.safeParse({ ...base, ...subjects[2], provider: { pluginId: 'example.tunnel', localId: 'tunnel', credential: 'invalid' } }).success).toBe(false);
        expect(contract.MachineSecretGrantV1Schema.safeParse({ ...base, ...subjects[2], environmentId: 'environment' }).success).toBe(false);

        const retainedPlugin = contract.MachineConnectorSecretGrantSubjectV1Schema.parse({ v: 1, kind: 'connectorToken',
            machineId: 'machine', installationId: 'installation', provider: { pluginId: 'example.tunnel', localId: 'tunnel' }, connectorId: 'connector' });
        expect(contract.machineSecretGrantSubjectKey(retainedPlugin))
            .toBe('[1,"connectorToken","machine","installation","example.tunnel","tunnel","connector"]');
        const builtinKey = '[1,"connectorToken","machine","installation",{"kind":"builtin","id":"cloudflare"},"connector"]';
        expect(contract.parseMachineSecretGrantSubjectKey(builtinKey)).toEqual({ v: 1, kind: 'connectorToken',
            machineId: 'machine', installationId: 'installation', provider: { kind: 'builtin', id: 'cloudflare' }, connectorId: 'connector' });
        expect(contract.parseMachineSecretGrantSubjectKey(builtinKey.replace('"kind":"builtin","id":"cloudflare"', '"id":"cloudflare","kind":"builtin"'))).toBeNull();
        expect(contract.parseMachineSecretGrantSubjectKey(builtinKey.replace('"id":"cloudflare"', '"id":"cloudflare","pluginId":"example.tunnel"'))).toBeNull();
        const first = { v: 1 as const, kind: 'secret' as const, machineId: 'machine', installationId: 'installation',
            environmentId: 'environment', resourceId: 'resource', resourceRevision: 3 };
        expect(contract.machineSecretGrantSubjectKey(first)).not.toBe(contract.machineSecretGrantSubjectKey({ ...first, resourceRevision: 4 }));
        expect(contract.machineSecretGrantSubjectKey(first)).not.toBe(contract.machineSecretGrantSubjectKey({ ...first, installationId: 'replacement' }));
        expect(contract.machineSecretGrantSubjectKey(first)).toBe(contract.machineSecretGrantSubjectKey({
            resourceRevision: 3, resourceId: 'resource', installationId: 'installation', machineId: 'machine',
            environmentId: 'environment', kind: 'secret', v: 1,
        }));
    });
});
