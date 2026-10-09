import { describe, expect, it } from 'vitest';
import { resolveToolCallsGroupPresentation, resolveToolCallsGroupStatus, shouldShowToolCallsGroupStatusIndicator } from './resolveToolCallsGroupPresentation';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';

describe('hidden tool group presentation', () => {
    it('retains an error or denied recovery indication while ordinary tool activity continues', () => {
        const running = createToolCallMessageFixture({ id: 'running' });
        const error = createToolCallMessageFixture({ id: 'error', tool: { ...running.tool, state: 'error' } });
        const denied = createToolCallMessageFixture({ id: 'denied', tool: { ...running.tool,
            permission: { id: 'approval', status: 'denied' } } });
        expect(resolveToolCallsGroupStatus({ toolMessages: [running, error], showToolCalls: false })).toBe('error');
        expect(resolveToolCallsGroupStatus({ toolMessages: [running, denied], showToolCalls: false })).toBe('permission_denied');
        expect(resolveToolCallsGroupStatus({ toolMessages: [running, error], showToolCalls: true })).toBe('running');
    });
    it('keeps the collapsed group header-only but reveals every tool after explicit disclosure', () => {
        const input = { showToolCalls: false, toolCalls: [1, 2], collapsedPreviewCount: 3 };
        expect(resolveToolCallsGroupPresentation({ ...input, expanded: false })).toMatchObject({
            visibleToolCalls: [], hiddenCount: 2, showBody: false, showExpandMore: false,
        });
        expect(resolveToolCallsGroupPresentation({ ...input, expanded: true })).toMatchObject({
            visibleToolCalls: [1, 2], hiddenCount: 0, showBody: true, showExpandMore: false,
        });
    });
    it('suppresses ordinary tool activity while retaining error and denied recovery indications', () => {
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'running' })).toBe(false);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'completed' })).toBe(false);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'error' })).toBe(true);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'permission_denied' })).toBe(true);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: true, status: 'running' })).toBe(true);
    });
});
