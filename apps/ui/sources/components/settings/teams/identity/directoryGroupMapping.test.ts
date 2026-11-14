import { describe, expect, it, vi } from 'vitest';
import { TeamGroupNameProjectionV1Schema } from '@happier-dev/protocol/teams';
import { teamCredentialDisplayNameFixture } from '@/dev/testkit/fixtures/teamFixtures';

import { runDirectoryGroupMappingChange } from './directoryGroupMapping';

describe('runDirectoryGroupMappingChange', () => {
    it('refuses to mutate a group projected by another directory source', async () => {
        const execute = vi.fn();

        await expect(runDirectoryGroupMappingChange({
            sourceId: 'source-a',
            group: {
                sourceId: 'source-b',
                externalGroupId: 'external-1',
                mapping: { state: 'unbound' },
            },
            target: { kind: 'directory_created' },
            execute,
        })).resolves.toEqual({ ok: false, code: 'directory_group_source_mismatch' });
        expect(execute).not.toHaveBeenCalled();
    });

    it('sets and removes only the exact projected external Group mapping', async () => {
        const execute = vi.fn(async () => ({ ok: true as const }));
        const group = {
            sourceId: 'source-a',
            externalGroupId: 'external-1',
            mapping: {
                state: 'bound' as const,
                bindingId: 'binding-1',
                mode: 'native_target' as const,
                teamGroupId: 'team-group-old',
                teamGroupName: TeamGroupNameProjectionV1Schema.parse({
                    kind: 'available', label: teamCredentialDisplayNameFixture('Existing Group'),
                }),
            },
        };

        await expect(runDirectoryGroupMappingChange({
            sourceId: 'source-a',
            group,
            target: { kind: 'native_target', teamGroupId: 'team-group-1' },
            execute,
        })).resolves.toEqual({ ok: true });
        expect(execute).toHaveBeenNthCalledWith(1, {
            kind: 'set',
            externalGroupId: 'external-1',
            target: { kind: 'native_target', teamGroupId: 'team-group-1' },
        });

        await expect(runDirectoryGroupMappingChange({
            sourceId: 'source-a',
            group,
            target: null,
            execute,
        })).resolves.toEqual({ ok: true });
        expect(execute).toHaveBeenNthCalledWith(2, { kind: 'remove', bindingId: 'binding-1' });
    });
});
