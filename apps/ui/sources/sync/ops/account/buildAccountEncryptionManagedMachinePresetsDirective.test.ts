import { describe, expect, it } from 'vitest';
import { buildAccountEncryptionManagedMachinePresetsDirective } from './buildAccountEncryptionManagedMachinePresetsDirective';

describe('personal preset Account transition', () => {
    it('converts legacy Plain recipes and retained snapshots during an E2EE to Plain transition without acquiring keys', async () => {
        const content = { t: 'plain' as const, v: { v: 1 as const, name: 'Legacy private recipe',
            setup: { scripts: [{ body: 'echo legacy' }] } } };
        const result = await buildAccountEncryptionManagedMachinePresetsDirective({
            accountId: 'owner', fromMode: 'e2ee', toMode: 'plain', targetContentPublicKey: null,
            openSourceDataKey: async () => { throw new Error('Legacy Plain has no source DEK'); },
            inventory: { presets: [{ presetId: 'legacy', expectedRevision: 4,
                contentEncryptionMode: 'plain', content, recipientEnvelope: null }],
                snapshots: [{ managedId: 'retained', presetId: 'legacy',
                    contentEncryptionMode: 'plain', content, recipientEnvelope: null }] },
        });
        expect(result).toEqual({ presets: [{ presetId: 'legacy', expectedRevision: 4,
            replacement: { content, recipients: [] } }], snapshots: [{ managedId: 'retained', presetId: 'legacy',
                expectedContentEncryptionMode: 'plain', expectedContent: content, expectedRecipientEnvelope: null,
                replacement: { content, recipients: [] } }] });
    });
});
