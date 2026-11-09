import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

installPermissionShellCommonModuleMocks({
    text: async () => {
        const text = await vi.importActual<typeof import('@/text')>('@/text');
        await text.preloadTranslations('en');
        text.setPreferredLanguageFromSettings('en');
        return text;
    },
    storage: importOriginal => importOriginal(),
});

const { PermissionPromptCard } = await import('./PermissionPromptCard');
const { PermissionAnswerOutcomeStatus } = await import('../presentation/ToolOutcomeStatus');

afterEach(standardCleanup);

const nativeChoices = {
    requirementId: 'occurrence', source: 'native',
    origin: { sessionId: 'parent', subagentId: 'child', subagentLabel: 'Repository explorer' },
    choices: [
        { id: 'once', label: 'Approve this exact command', decision: 'approved' as const, scope: 'once' as const, response: { approved: true } },
        { id: 'remember', label: 'Remember this command', decision: 'approved' as const, scope: 'localPersistent' as const, response: { approved: true } },
    ],
};

describe('native permission transcript projection', () => {
    it('renders the authorized owner and producer-authored subagent names on the pending card', async () => {
        const source = createTestSessionTranscriptSource({ sessionId: 'parent', interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission: async () => {}, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        });
        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard sessionId="parent" metadata={null}
            canApprovePermissions location={null} request={{ id: 'permission', kind: 'permission', createdAt: 1, tool: 'Shell', arguments: { command: 'pwd' },
                nativeChoices, permissionOwnerLabel: 'Ada Lovelace', nativeChoiceAvailability: [
                    { choiceId: 'once', allowed: true }, { choiceId: 'remember', allowed: false, reason: 'owner_required' },
                ] }} />, source);
        expect.soft(screen.getTextContent()).toContain('Repository explorer');
        expect.soft(screen.getTextContent()).toContain('Ada Lovelace');
        const lasting = screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'permission-footer.choice.remember');
        expect(lasting.some(node => node.props.accessibilityState?.disabled === true)).toBe(true);
    });

    it('renders the exact settled choice after the real reducer starts the tool and receives completion', async () => {
        const state = createReducer();
        const request = { tool: 'Shell', arguments: { command: 'pwd' }, createdAt: 1, nativeChoices };
        reducer(state, [], AgentStateSchema.parse({ requests: { permission: request } }));
        const tool = state.messages.get(state.toolIdToMessageId.get('permission')!)!.tool!;
        tool.startedAt = 2;
        tool.permission!.status = 'approved';
        reducer(state, [], AgentStateSchema.parse({ completedRequests: { permission: { ...request,
            completedAt: 3, status: 'approved', nativeChoice: { requirementId: 'occurrence', choiceId: 'once' },
        } } }));
        const source = createTestSessionTranscriptSource({ sessionId: 'parent' });
        const screen = await renderWithSessionTranscriptSource(<PermissionAnswerOutcomeStatus permission={tool.permission!} />, source);
        expect(screen.getTextContent()).toContain('Approve this exact command');
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'tool-timeline-row-native-answer')).toHaveLength(1);
    });
});
