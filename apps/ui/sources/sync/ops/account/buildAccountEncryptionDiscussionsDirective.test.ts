import { describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DiscussionAccountEncryptionInventoryV1Schema } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { Encryption } from '@/sync/encryption/encryption';
import { buildAccountEncryptionDiscussionsDirective } from './buildAccountEncryptionDiscussionsDirective';
import { hashBinaryContent, openBinaryContent, createBinaryContentEncryption } from '@/sync/encryption/binaryContent';
import type { BinaryBlobStoredContentV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { decodeBase64 } from '@/encryption/base64';

describe('Account Discussion conversion client', () => {
    it('reseals folder leaf bytes through staged custody and retains empty directories in both directions', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const scope = { scope: { serverId: 'home', accountId: 'owner' }, isCurrent: () => true };
        const bytes = Uint8Array.of(0, 255, 18, 23);
        const blobId = 'a70dc166-a682-42cf-a1bf-09cc07dadcaa';
        const reference = { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length, sha256: hashBinaryContent(bytes) };
        const titleContent = { t: 'plain' as const, v: { v: 1, title: 'Folder' } };
        const content = { t: 'plain' as const, v: { v: 1, parts: [{ t: 'attachment', attachment: {
            kind: 'folder', id: '842b1ec7-7b89-408d-a7fe-eb36592b5b33', name: 'Tree',
            entries: [{ relativePath: 'nested/file.bin', file: reference }], directories: ['nested', 'empty'],
        } }, { t: 'attachment', attachment: { kind: 'folder', id: '9fa28429-94a0-4c8a-b07e-a614267fe38c',
            name: 'Empty folder', entries: [], directories: [] } }] } };
        const inventory = DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [{ discussionId: 'discussion', titleContent,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, messages: [{ id: 'message', content,
                attachments: [{ blobId, encryptionMode: 'plain', storedSizeBytes: bytes.length }] }], recipients: {
                discussionId: 'discussion', ownerAccountId: 'owner', encryptionMode: 'plain', access: 'owner',
                dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
            } }] });
        let stored: BinaryBlobStoredContentV1 = { t: 'plain', v: 'AP8SFw==' };
        let acquisitions = 0;
        // The callbacks stand in for authenticated network/private-storage IO only.
        const readAttachment = async () => { acquisitions++; return { blobId, content: stored }; };
        const stageAttachment = async (_discussionId: string, _messageId: string, _blobId: string, next: BinaryBlobStoredContentV1) => {
            stored = next;
            return { t: next.t, uploadId: '36f558cc-8c97-45a9-b71c-7c4764bc5a78',
                contentSha256: hashBinaryContent(decodeBase64(next.t === 'plain' ? next.v : next.c)) };
        };
        const encrypted = await buildAccountEncryptionDiscussionsDirective({ inventory, fromMode: 'plain', toMode: 'e2ee',
            sourceEncryption: null, targetEncryption: encryption, scope, readAttachment, stageAttachment });
        const original = inventory.items[0]!;
        if (!('recipients' in original)) throw new Error('Expected the independent Discussion census');
        const converted = encrypted.items[0]!;
        const readStoredContent = (): BinaryBlobStoredContentV1 => stored;
        const encryptedContent = readStoredContent();
        expect(converted.messages[0]!.attachments).toEqual([{ blobId, expectedContentSha256: reference.sha256,
            content: { t: 'encrypted', uploadId: '36f558cc-8c97-45a9-b71c-7c4764bc5a78',
                contentSha256: hashBinaryContent(decodeBase64(encryptedContent.t === 'plain' ? encryptedContent.v : encryptedContent.c)) } }]);
        expect(JSON.stringify(converted.messages[0]!.attachments)).not.toContain('AP8SFw==');
        const dataKey = await encryption.decryptEncryptionKey(converted.dataEncryptionKey, scope.scope);
        expect(await openBinaryContent({ reference, content: encryptedContent, mode: 'e2ee', encryption: createBinaryContentEncryption(dataKey!) })).toEqual(bytes);
        const reverse = DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [{ ...original,
            titleContent: converted.titleContent, dataEncryptionKey: converted.dataEncryptionKey,
            messages: converted.messages.map(message => ({ id: message.id, content: message.content,
                attachments: [{ blobId, encryptionMode: 'e2ee', storedSizeBytes: bytes.length }] })),
            recipients: { ...original.recipients, encryptionMode: 'e2ee', dataEncryptionKey: converted.dataEncryptionKey,
                callerDataEncryptionKey: converted.dataEncryptionKey },
        }] });
        const plain = await buildAccountEncryptionDiscussionsDirective({ inventory: reverse, fromMode: 'e2ee', toMode: 'plain',
            sourceEncryption: encryption, targetEncryption: null, scope, readAttachment, stageAttachment });
        expect(plain.items[0]!.messages[0]!.content).toEqual(content);
        expect(stored).toEqual({ t: 'plain', v: 'AP8SFw==' });
        expect(acquisitions).toBe(2);
    });
    it('refuses a retained byte binding absent from the opened message before changing Account mode', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const inventory = { items: [{ discussionId: 'discussion',
            titleContent: { t: 'plain' as const, v: { v: 1, title: 'Private title' } },
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            messages: [{ id: 'message', content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Text' }] } },
                attachments: [{ blobId: 'a70dc166-a682-42cf-a1bf-09cc07dadcaa', encryptionMode: 'plain' as const, storedSizeBytes: 3 }] }],
            recipients: { discussionId: 'discussion', ownerAccountId: 'owner', encryptionMode: 'plain' as const,
                access: 'owner' as const, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] },
        }] };
        await expect(buildAccountEncryptionDiscussionsDirective({ inventory, fromMode: 'plain', toMode: 'e2ee',
            sourceEncryption: null, targetEncryption: encryption,
            scope: { scope: { serverId: 'home', accountId: 'owner' }, isCurrent: () => true },
        })).rejects.toThrow('attachment census');
    });
    it('uses the resource DEK codec to preserve title and every message in both directions', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const scope = { scope: { serverId: 'home', accountId: 'owner' }, isCurrent: () => true };
        const titleContent = { t: 'plain' as const, v: { v: 1, title: 'Private title' } };
        const content = { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Private message' }] } };
        const inventory = DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [{ discussionId: 'discussion', titleContent,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, messages: [{ id: 'message', content }], recipients: {
                discussionId: 'discussion', ownerAccountId: 'owner', encryptionMode: 'plain', access: 'owner',
                dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
            } }] });
        const encrypted = await buildAccountEncryptionDiscussionsDirective({ inventory, fromMode: 'plain', toMode: 'e2ee',
            sourceEncryption: null, targetEncryption: encryption, scope });
        const original = inventory.items[0]!;
        if (!('recipients' in original)) throw new Error('Expected the independent Discussion census');
        const converted = encrypted.items[0]!;
        expect(converted.titleContent.t).toBe('encrypted');
        const targetBytes = JSON.stringify({ title: converted.titleContent, messages: converted.messages.map(message => message.content) });
        expect(targetBytes).not.toContain('Private title');
        expect(targetBytes).not.toContain('Private message');
        const reverseInventory = DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [{ ...original,
            titleContent: converted.titleContent, dataEncryptionKey: converted.dataEncryptionKey,
            messages: converted.messages.map(message => ({ id: message.id, content: message.content })),
            recipients: { ...original.recipients, encryptionMode: 'e2ee',
                dataEncryptionKey: converted.dataEncryptionKey, callerDataEncryptionKey: converted.dataEncryptionKey },
        }] });
        const plain = await buildAccountEncryptionDiscussionsDirective({ inventory: reverseInventory, fromMode: 'e2ee', toMode: 'plain',
            sourceEncryption: encryption, targetEncryption: null, scope });
        expect(plain.items[0]).toMatchObject({ dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, titleContent,
            messages: [{ id: 'message', content }], recipientKeyEnvelopes: [] });
        await expect(buildAccountEncryptionDiscussionsDirective({ inventory: reverseInventory, fromMode: 'e2ee', toMode: 'plain',
            sourceEncryption: null, targetEncryption: null, scope })).rejects.toThrow('key unavailable');
    });
});
