import { describe, expect, it } from 'vitest';

import { EmbedConfigV1Schema } from './embedConfigV1.js';
import { ApiTokenGrantV1Schema, evaluateApiTokenGrantV1 } from '../auth/apiTokenGrant.js';
import type { SessionPermissionMode } from '../sessions/metadata/sessionPermissionModes.js';
import { buildEmbedParentGrantV1, deriveEmbedAccessFromGrantV1, type EmbedAccessV1 } from './buildEmbedParentGrantV1.js';

describe('EmbedConfigV1', () => {
  it('accepts the saved presentation and placement contract and rejects copied authority or unknown nested fields', () => {
    const config = { v: 1, ui: { attachments: true }, newChat: { enabled: true }, organization: { folderId: null, tagIds: ['lead'] }, style: null };
    expect(EmbedConfigV1Schema.parse(config)).toEqual(config);
    for (const invalid of [
      { ...config, send: true },
      { ...config, ui: { attachments: true, approve: true } },
      { ...config, newChat: { enabled: true, machineId: 'm' } },
      { ...config, organization: { folderId: null, tagIds: ['lead', 'lead'] } },
      { ...config, style: { v: 1, css: '' } },
      { ...config, ui: { attachments: 'true' } },
    ]) expect(EmbedConfigV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('round-trips all access controls through the canonical grant without granting unrelated actions', () => {
    const organization = { folderId: 'folder', tagIds: ['lead'] };
    const create: NonNullable<EmbedAccessV1['create']> = {
      machineId: 'machine', agentTargetKey: 'agent:happier.agent.claude/claude', directory: 'managed', placement: organization,
    };
    const modeChoices: (SessionPermissionMode[] | null)[] = [null, ['default'], ['default', 'read-only']];
    for (const send of [false, true]) for (const approve of [false, true]) for (const changeModel of [false, true]) {
      for (const creation of [null, create]) for (const permissionModes of modeChoices) {
        const options: EmbedAccessV1 = { send, approve, changeModel, models: null, permissionModes, sites: ['https://example.com'], create: creation };
        const config = EmbedConfigV1Schema.parse({ v: 1, ui: { attachments: true }, newChat: creation ? { enabled: true } : null, organization, style: null });
        const grant = buildEmbedParentGrantV1(options, config);
        expect(ApiTokenGrantV1Schema.parse(grant)).toEqual(grant);
        expect(deriveEmbedAccessFromGrantV1(grant)).toEqual(options);
        expect(grant.approve).toBe(approve);
        expect(grant.targets).toBeNull();
        expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.message.send' }).ok).toBe(send);
        expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.user_action.answer' }).ok).toBe(send);
        expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.turn.cancel' }).ok).toBe(send);
        expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.stop' }).ok).toBe(false);
        expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.model.set' }).ok).toBe(changeModel);
        expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.permission_mode.set' }).ok).toBe((permissionModes?.length ?? 0) > 1);
        expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.archive' }).ok).toBe(false);
      }
    }
  });

  it('canonicalizes creation placement and refuses an enabled new chat without a creation grant', () => {
    const config = EmbedConfigV1Schema.parse({ v: 1, ui: { attachments: false }, newChat: { enabled: true }, organization: { folderId: 'chosen', tagIds: [] }, style: null });
    const options: EmbedAccessV1 = { send: false, approve: false, changeModel: false, models: [{ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'model' }], permissionModes: ['default'], sites: [], create: null };
    expect(() => buildEmbedParentGrantV1(options, config)).toThrow();
    const grant = buildEmbedParentGrantV1({ ...options, create: { machineId: 'machine', agentTargetKey: 'agent:happier.agent.claude/claude', directory: 'managed', placement: { folderId: 'stale', tagIds: [] } } }, config);
    expect(grant.create?.placement).toEqual(config.organization);
    expect(deriveEmbedAccessFromGrantV1(grant).models).toEqual(options.models);
    expect(() => buildEmbedParentGrantV1({ ...options, sites: ['https://example.com/'] }, { ...config, newChat: null })).toThrow();
  });
});
