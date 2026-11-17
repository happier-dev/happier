import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '@/modal';

import {
    confirmDeleteApprovalProfile,
    createApprovalProfileFromStart,
    renameApprovalProfile,
    type ApprovalProfileWriter,
} from './approvalProfileWrites';

// Person input is the presentation boundary; profile content and Action operands remain real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const revision = { headerVersion: 2, bodyVersion: 7 };
const row = {
    id: 'artifact-careful',
    profile: { id: 'artifact-careful', name: 'Careful', actions: { 'session.stop': { disabledSurfaces: ['agent' as const] } } },
    access: 'owner' as const,
    revision,
};

// APPROVED Plan03 U1: create receives its identity from the Artifact receipt; edits use held CAS revisions.
describe('approval profile writes', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a copy with the Artifact receipt identity and no client-supplied id', async () => {
        vi.mocked(Modal.prompt).mockResolvedValue('  New name  ');
        const write = vi.fn<ApprovalProfileWriter>().mockResolvedValue({
            ok: true,
            result: { profileChange: { kind: 'create', id: 'artifact-created', revision } },
        });
        const created = await createApprovalProfileFromStart(write, row.profile);
        expect(write).toHaveBeenCalledWith({ profileChange: {
            kind: 'create', profile: { name: 'New name', actions: row.profile.actions },
        } });
        expect(created).toEqual({ id: 'artifact-created', name: 'New name', actions: row.profile.actions });
    });

    it('renames and deletes the existing Artifact with its revision', async () => {
        vi.mocked(Modal.prompt).mockResolvedValue('Renamed');
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const write = vi.fn<ApprovalProfileWriter>().mockResolvedValue({
            ok: true,
            result: { profileChange: { kind: 'update', id: row.id, revision } },
        });
        await renameApprovalProfile(write, row);
        expect(write).toHaveBeenLastCalledWith({ profileChange: {
            kind: 'update', id: row.id, expectedRevision: revision,
            profile: { name: 'Renamed', actions: row.profile.actions },
        } });
        await expect(confirmDeleteApprovalProfile(write, row)).resolves.toBe(true);
        expect(write).toHaveBeenLastCalledWith({ profileChange: {
            kind: 'delete', id: row.id, expectedRevision: revision,
        } });
    });
});
