import { describe, expect, it } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

import { createEmbedEncryption } from '@/embed/encryption/createEmbedEncryption';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { fetchAndApplySessionById } from './sessionById';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';

describe('scoped bounded plain composer hydration', () => {
    it.each([0, 1])('projects layout %i owner input only from persisted plain Account authority', async (layout) => {
        const root = await createEmbedEncryption();
        const modelOverrideV1 = { v: 1 as const, modelId: 'chosen-model', updatedAt: 10 };
        const controls = { modelOverrideV1, permissionMode: 'read-only', permissionModeUpdatedAt: 321 };
        const owner = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { path: '/private' }, runtime: controls });
        try {
            for (const accountMode of ['plain', 'e2ee'] as const) {
              for (const canSet of [false, true]) {
                const composerOptionsGrant = canSet ? API_TOKEN_FULL_GRANT_V1 : { ...API_TOKEN_FULL_GRANT_V1,
                    actions: { families: [], ids: ['session.transcript.get'] } };
                const result = await fetchAndApplySessionById({
                    sessionId: 's', credentials: { token: 'child' }, accountMode, sessionKey: null, composerOptionsInput: null,
                    composerOptionsGrant,
                    encryption: root.encryption, sessionDataKeys: new Map(), applySessions: () => {}, log: { log: () => {} },
                    includeTurnsProjection: false,
                    request: async () => Response.json({ session: {
                        id: 's', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
                        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: layout, metadataVersion: 1,
                        metadata: JSON.stringify(layout === 0 ? { path: '/private', host: 'private', flavor: 'codex', ...controls }
                            : { v: 1, agentPresentation: { agentId: 'codex' } }),
                        ...(layout === 1 ? { ownerMetadata: accountMode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1(owner)
                            : sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: owner, material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
                                randomBytes: (length) => new Uint8Array(length).fill(7) }) } : {}),
                        agentStateVersion: 0, agentState: null, share: null,
                    } }),
                });
                expect(result.ok).toBe(true);
                expect(result.session?.composerOptionsInput).toEqual(accountMode === 'plain' ? canSet ? controls : {} : null);
                expect(result.session?.ownerMetadataView).toBeNull();
                expect(result.session?.metadataProjection).toBe('sessionOnly');
                expect(hasAuthoritativeSessionRouteData(result.session)).toBe(true);
                expect(result.session && readSessionOwnerMetadataView(result.session)).toBeNull();
              }
            }
        } finally { root.dispose(); }
    });
});
