import { describe, expect, it } from 'vitest';
import { applyComposerControlAcknowledgementV1, ComposerOptionsInputV1Schema, EmbedSessionOptionsV1Schema, projectComposerOptionsInputV1 } from './embedSessionOptionsV1.js';

describe('bounded composer options projection', () => {
    it('retains current controls on another Session, failed or malformed acknowledgement and uses the armed active model', () => {
        const options = projectComposerOptionsInputV1({ permissionMode: 'read-only', permissionModeUpdatedAt: 10 });
        for (const result of [
            { ok: true, sessionId: 'other', permissionMode: 'default', updatedAt: 20 },
            { ok: false, sessionId: 's', permissionMode: 'default', updatedAt: 20 },
            { ok: true, sessionId: 's', permissionMode: 'invalid', updatedAt: 20 },
        ]) expect(applyComposerControlAcknowledgementV1({ sessionId: 's', options,
            actionId: 'session.permission_mode.set', result })).toBe(options);
        const activeSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'active' };
        expect(applyComposerControlAcknowledgementV1({ sessionId: 's', options, actionId: 'session.model.set',
            result: { ok: true, sessionId: 's', modelId: 'requested', status: 'armed', activeSelection,
                requestedSelection: { ...activeSelection, modelId: 'requested' } },
        })).toEqual({ ...options, modelSelectionIntentV1: { v: 1, selection: activeSelection, updatedAt: 0 } });
    });
    it('retains existing alias inputs without exporting the complete owner view', () => {
        const override = { v: 1, updatedAt: 10, overrides: { thinking: { value: true, updatedAt: 10 } } };
        const owner = projectComposerOptionsInputV1({
            path: '/private', machineId: 'private-machine', connectedServices: { secret: true },
            sessionConfigOptionOverridesV1: override, acpConfigOptionOverridesV1: override,
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'chosen' },
        });
        expect(owner).toEqual({ sessionConfigOptionOverridesV1: override, acpConfigOptionOverridesV1: override,
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'chosen' } });
        expect(ComposerOptionsInputV1Schema.safeParse({ ...owner, path: '/leak' }).success).toBe(false);
        expect(EmbedSessionOptionsV1Schema.safeParse({ v: 1, sessionId: 's', owner }).success).toBe(true);
        expect(EmbedSessionOptionsV1Schema.safeParse({ v: 1, sessionId: 's', owner, handoff: {} }).success).toBe(false);
    });
});
