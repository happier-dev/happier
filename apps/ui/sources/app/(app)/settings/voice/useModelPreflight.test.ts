import { describe, expect, it } from 'vitest';

import {
    normalizePreflightModelList,
    resolveMediatorAgentIdForModelMenus,
} from './useModelPreflight';

describe('resolveMediatorAgentIdForModelMenus', () => {
    it('returns selected agent when source is agent', () => {
        expect(resolveMediatorAgentIdForModelMenus({ source: 'agent', agentId: 'codex' })).toBe('codex');
    });

    it('falls back to claude when source is session', () => {
        expect(resolveMediatorAgentIdForModelMenus({ source: 'session', agentId: 'opencode' })).toBe('claude');
    });
});

describe('normalizePreflightModelList', () => {
    it('returns null when payload is invalid', () => {
        expect(normalizePreflightModelList(null)).toBeNull();
        expect(normalizePreflightModelList({})).toBeNull();
        expect(normalizePreflightModelList({ availableModels: 'nope' })).toBeNull();
    });

    it('keeps valid model entries and preserves supportsFreeform', () => {
        expect(
            normalizePreflightModelList({
                availableModels: [
                    { id: 'gpt-4.1', name: 'GPT-4.1', description: 'General' },
                    { id: 'bad-no-name' },
                ],
                supportsFreeform: true,
            }),
        ).toEqual({
            availableModels: [{ id: 'gpt-4.1', name: 'GPT-4.1', description: 'General' }],
            supportsFreeform: true,
        });
    });
});
