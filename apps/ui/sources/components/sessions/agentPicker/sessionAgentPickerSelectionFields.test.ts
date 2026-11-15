import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { resolveSessionAgentPickerSelectionFields } from './sessionAgentPickerSelectionFields';

const codex = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
const codexKey = 'agent:happier.agent.codex/codex';

describe('one writer from an Agent picker selection to authored engine fields', () => {
    it('keeps a matching Provider-connected selection, and the Agent default is no selection', () => {
        const connected = { v: 1 as const, updatedAt: 3, ref: { agentTargetKey: codexKey, providerConnectionId: ProviderConnectionIdSchema.parse('conn'), modelId: 'muse' } };
        expect(resolveSessionAgentPickerSelectionFields({ agentTarget: codex, updatedAt: 9,
            selection: { modelId: 'muse', modelSelection: connected, sessionModeId: null, configOverrides: {} } }).modelSelection).toBe(connected);
        expect(resolveSessionAgentPickerSelectionFields({ agentTarget: codex, updatedAt: 9,
            selection: { modelId: 'default', sessionModeId: null, configOverrides: {} } }).modelSelection).toBeNull();
        // A structured selection for another model is not this choice: the chosen model id wins.
        expect(resolveSessionAgentPickerSelectionFields({ agentTarget: codex, updatedAt: 9,
            selection: { modelId: 'gpt', modelSelection: connected, sessionModeId: null, configOverrides: {} } }).modelSelection)
            .toEqual({ v: 1, updatedAt: 9, ref: { agentTargetKey: codexKey, providerConnectionId: null, modelId: 'gpt' } });
    });

    it('writes trimmed string choices and keeps the typed overrides the pane cannot edit', () => {
        const fields = resolveSessionAgentPickerSelectionFields({ agentTarget: codex, updatedAt: 9,
            selection: { modelId: 'default', sessionModeId: 'plan', configOverrides: { reasoning_effort: ' high ', empty: '  ' } },
            retainedOverrides: { v: 1, updatedAt: 1, overrides: { sandbox: { value: true, updatedAt: 1 }, reasoning_effort: { value: 'low', updatedAt: 1 } } } });
        expect(fields.acpSessionModeId).toBe('plan');
        expect(fields.sessionConfigOptionOverrides).toEqual({ v: 1, updatedAt: 9, overrides: {
            sandbox: { value: true, updatedAt: 1 }, reasoning_effort: { value: 'high', updatedAt: 9 } } });
        expect(resolveSessionAgentPickerSelectionFields({ agentTarget: codex, updatedAt: 9,
            selection: { modelId: 'default', sessionModeId: null, configOverrides: {} } }).sessionConfigOptionOverrides).toBeNull();
    });
});
