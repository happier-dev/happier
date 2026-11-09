import { describe, expect, it } from 'vitest';
import type { AccountApiTokenSelfV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { buildEmbedParentGrantV1, type EmbedAccessV1 } from '@happier-dev/protocol/embed';

import { buildEmbedSessionPresentation } from './embedSessionPresentation';

const CONFIG = { v: 1, ui: { attachments: true }, newChat: null, organization: { folderId: null, tagIds: [] }, style: null } satisfies NonNullable<AccountApiTokenSelfV1['embedConfig']>;
const ACCESS: EmbedAccessV1 = {
    send: true, approve: false, changeModel: false, models: null, permissionModes: ['default'], sites: ['https://crm.acme.dev'], create: null,
};

function selfWith(access: Partial<EmbedAccessV1>): AccountApiTokenSelfV1 {
    return {
        accountId: 'account-1',
        accountEncryptionMode: 'plain',
        credentialId: '11111111-1111-4111-8111-111111111111',
        parentTokenId: '22222222-2222-4222-8222-222222222222',
        expiresAt: null,
        grant: buildEmbedParentGrantV1({ ...ACCESS, ...access }, CONFIG),
        embedConfig: CONFIG,
    };
}

describe('embed session presentation', () => {
    it('keeps transcript route navigation inside the host boundary', () => {
        expect(buildEmbedSessionPresentation({ phase: 'ready', self: selfWith({}), ui: {} }).navigation).toBe('none');
    });

    it('retains the mounted input while reconnecting and locks submission', () => {
        expect(buildEmbedSessionPresentation({ phase: 'error', self: selfWith({}), ui: {}, reconnecting: true }))
            .toMatchObject({ composer: 'auto', composerInputLocked: true });
    });
    it('shows the model picker only when the grant lets chats change model, and the host has not hidden it', () => {
        expect(buildEmbedSessionPresentation({ phase: 'ready', self: selfWith({ changeModel: false }), ui: {} }).modelPicker).toBe(false);
        expect(buildEmbedSessionPresentation({ phase: 'ready', self: selfWith({ changeModel: true }), ui: {} }).modelPicker).toBe(true);
        expect(buildEmbedSessionPresentation({ phase: 'ready', self: selfWith({ changeModel: true }), ui: { modelPicker: false } }).modelPicker).toBe(false);
        // A host override can hide the picker, never add one the grant refuses.
        expect(buildEmbedSessionPresentation({ phase: 'ready', self: selfWith({ changeModel: false }), ui: { modelPicker: true } }).modelPicker).toBe(false);
        expect(buildEmbedSessionPresentation({ phase: 'loading', self: null, ui: {} }).modelPicker).toBe(false);
    });

    it('carries Change model as its own authority, independent of Send', () => {
        // Send off, Change model on: the frame keeps a model control even though it cannot send.
        expect(buildEmbedSessionPresentation({ phase: 'ready', self: selfWith({ send: false, changeModel: true }), ui: {} }))
            .toMatchObject({ modelPicker: true, modelSelectionGranted: true });
        expect(buildEmbedSessionPresentation({ phase: 'ready', self: selfWith({ send: true, changeModel: false }), ui: {} }).modelSelectionGranted)
            .toBe(false);
    });
});
