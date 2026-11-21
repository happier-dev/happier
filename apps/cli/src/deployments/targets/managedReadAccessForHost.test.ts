import { describe, expect, it, vi } from 'vitest';
import type { DatabaseReadRoleSetupResult } from '@happier-dev/databases';
import { createManagedReadAccessForHost } from './managedReadAccessForHost';

const endpoint = { connectionString: 'postgresql://db.example.test/app', ca: 'provider-ca' };
const readLogin = 'postgresql://reader:fixture-password@db.example.test:5432/app?sslmode=disable';
const writeLogin = 'postgresql://writer:fixture-writer@db.example.test/app';
const plan = { engine: 'postgresql' as const, database: 'app', role: 'happier_ro_example',
    statements: ['CREATE ROLE happier_ro_example LOGIN PASSWORD $1'] };
const secretRef = { ref: 'shared-secret-reference', resourceRevision: 4 };

function fixture() {
    const connection = { engine: 'postgresql' as const, execute: vi.fn(), close: vi.fn(async () => {}),
        verifyReadRole: vi.fn(async () => ({ ok: true as const })),
        prepareReadRole: vi.fn(async () => plan),
        setupReadRole: vi.fn(async (): Promise<DatabaseReadRoleSetupResult> => ({ ok: true, password: 'fixture-generated' })) };
    const ports = { engine: 'postgresql' as const, database: 'app', signal: new AbortController().signal,
        readEndpoint: vi.fn(async () => endpoint),
        readBinding: vi.fn(async (role: 'readOnlyPassword' | 'write') => role === 'write' ? writeLogin : undefined),
        readSavedSecret: vi.fn(async () => readLogin), saveSecret: vi.fn(async () => secretRef),
        setBinding: vi.fn(async () => {}), open: vi.fn(async () => connection) };
    return { connection, ports, access: createManagedReadAccessForHost(ports) };
}

describe('managed read-access setup', () => {
    it('refuses reads with both setup choices before opening a connection or fetching a writer', async () => {
        const { access, ports } = fixture();
        await expect(access.openRead()).rejects.toMatchObject({ code: 'read_role_setup_required' });
        expect(ports.readBinding.mock.calls).toEqual([['readOnlyPassword']]);
        expect(ports.open).not.toHaveBeenCalled();
    });

    it('verifies the selected saved login at the linked endpoint before binding the exact reference', async () => {
        const { access, connection, ports } = fixture();
        await expect(access.attach(secretRef)).resolves.toEqual({ ok: true, status: 'configured' });
        expect(ports.open).toHaveBeenCalledWith('postgresql', 'postgresql://reader:fixture-password@db.example.test/app',
            { ca: 'provider-ca' }, ports.signal);
        expect(connection.verifyReadRole).toHaveBeenCalled();
        expect(ports.setBinding).toHaveBeenCalledWith(secretRef);
        expect(ports.saveSecret).not.toHaveBeenCalled();
    });

    it('does not send misdirected credentials or persist a login that fails the engine guard', async () => {
        const { access, ports, connection } = fixture();
        ports.readSavedSecret.mockResolvedValueOnce('postgresql://reader:fixture-password@other.example.test/app');
        await expect(access.attach(secretRef)).rejects.toMatchObject({ code: 'target_mismatch' });
        expect(ports.open).not.toHaveBeenCalled();
        connection.verifyReadRole.mockRejectedValueOnce(new Error('fixture-password'));
        await expect(access.attach(secretRef)).rejects.toMatchObject({ code: 'read_role_invalid', message: 'read_role_invalid' });
        expect(ports.setBinding).not.toHaveBeenCalled();
    });

    it('previews, refuses changed SQL and executes the unchanged plan without projecting the generated secret', async () => {
        const { access, connection, ports } = fixture();
        await expect(access.create({ mode: 'preview' })).resolves.toEqual({ ok: true, status: 'review',
            role: plan.role, statements: plan.statements });
        expect(connection.setupReadRole).not.toHaveBeenCalled();
        connection.setupReadRole.mockResolvedValueOnce({ ok: false, status: 'failed', code: 'database_read_role_plan_changed' });
        await expect(access.create({ mode: 'apply', role: plan.role, statements: ['GRANT ALL'] }))
            .rejects.toMatchObject({ code: 'database_read_role_plan_changed' });
        expect(ports.saveSecret).not.toHaveBeenCalled();
        await expect(access.create({ mode: 'apply', role: plan.role, statements: plan.statements }))
            .resolves.toEqual({ ok: true, status: 'configured' });
        expect(connection.setupReadRole).toHaveBeenCalledWith(plan, ports.signal);
        expect(ports.saveSecret).toHaveBeenCalledWith('postgresql://happier_ro_example:fixture-generated@db.example.test/app');
        expect(ports.setBinding).toHaveBeenCalledWith(secretRef);
    });
});
