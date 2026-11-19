import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { EnvironmentSecretLaunchAdmissionResultV1Schema } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { readEnvironmentMachineSecretGrantsInTx, syncEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';

describe('retained Machine grant storage', () => {
    it('projects the exact pre-label row without rewriting and refuses it at the new mutation boundary', async () => {
        // Pre-SECOND storage producer used the env name as its exact subject operand.
        const subject = { v: 1 as const, kind: 'environmentValues' as const, machineId: 'machine', installationId: 'installation',
            environmentId: 'environment', binding: { purpose: 'variable' as const, phase: 'runtime' as const, name: 'RETAINED_ENDPOINT' } };
        const subjectKey = createHash('sha256').update(JSON.stringify([1, 'environmentValues', 'machine', 'installation',
            'environment', 'variable', 'runtime', 'RETAINED_ENDPOINT'])).digest('hex');
        const row = { subjectKey, kind: subject.kind, machineId: subject.machineId, installationId: subject.installationId,
            environmentId: subject.environmentId, phase: subject.binding.phase, name: subject.binding.name,
            resourceId: null, resourceRevision: null, providerPluginId: null, providerLocalId: null, connectorId: null,
            contentEnvelope: 'retained-authenticated-ciphertext' } satisfies NonNullable<Awaited<ReturnType<Tx['machineSecretGrant']['findUnique']>>>;
        const snapshot = structuredClone(row);
        const create = vi.fn(), update = vi.fn(), remove = vi.fn();
        // The database is the genuine boundary; repository parsing, identity and admission stay real.
        const tx = { machineSecretGrant: { findMany: async () => [row], create, update, delete: remove } } as unknown as Tx;
        const grants = await readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: 'environment', machineId: 'machine', installationId: 'installation' });
        expect(grants).toEqual([{ ...subject, sealedContent: row.contentEnvelope }]);
        expect(EnvironmentSecretLaunchAdmissionResultV1Schema.safeParse({ ok: true, grants }).success).toBe(true);
        expect(row).toEqual(snapshot);
        await expect(syncEnvironmentSecretGrantsInTx(tx, { environmentId: 'environment', grants })).rejects.toMatchObject({ code: 'secret_missing' });
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        row.name = 'invalid-name';
        await expect(readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: 'environment' })).rejects.toMatchObject({ code: 'secret_missing' });
    });
});
