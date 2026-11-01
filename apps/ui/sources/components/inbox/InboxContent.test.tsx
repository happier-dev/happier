import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { InboxContentModel } from './useInboxContentModel';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({ RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner' }));
vi.mock('@/components/inbox/cards/ApprovalInboxCard', () => ({ ApprovalInboxCard: 'ApprovalInboxCard' }));
vi.mock('@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard', () => ({ InboxSessionAttentionGroupCard: 'InboxSessionAttentionGroupCard' }));
vi.mock('@/components/inbox/InboxSessionReviewRow', () => ({ InboxSessionReviewRow: 'InboxSessionReviewRow' }));
vi.mock('@/components/inbox/InboxMarkAllReadButton', () => ({ InboxMarkAllReadButton: 'InboxMarkAllReadButton' }));
vi.mock('@/components/ui/lists/ListSection', () => ({
    ListSection: (props: Record<string, unknown>) => React.createElement('ListSection', props, props.children as React.ReactNode),
}));
vi.mock('@/components/inbox/actionOperations/ActionOperationLedger', () => ({ ActionOperationRows: 'ActionOperationRows' }));
vi.mock('@/components/sessions/shell/SessionListIdentity', () => ({
    SessionListIdentity: 'SessionListIdentity',
    useSessionListIdentityDisplay: () => 'agentLogo',
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/components/ui/lists/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/cards/UserCard', () => ({ UserCard: 'UserCard' }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const failedSession = {
    id: 'failed',
    metadata: { name: 'Failed' },
    active: true,
} as never;
const readySession = {
    id: 'ready',
    metadata: { name: 'Ready' },
    active: true,
} as never;
const actionableSession = {
    id: 'actionable',
    metadata: { name: 'Actionable' },
    active: true,
} as never;

const routineOperation = {
    version: 1,
    operationId: 'routine-running',
    revision: 2,
    actionId: 'session.spawn_new',
    state: 'running',
    scope: { accountId: 'account-1', machineId: 'machine-1' },
    title: 'Create session',
    createdAt: 1,
    cancellation: 'supported',
} as const;
const actionableOperation = {
    ...routineOperation,
    operationId: 'failed-operation',
    revision: 3,
    state: 'failed',
    settledAt: 2,
} as const;

function createModel(sessionListIdentityDisplay: InboxContentModel['sessionListIdentityDisplay'] = 'agentLogo'): InboxContentModel {
    const readyTarget = {
        key: 'home:ready',
        sessionId: 'ready',
        serverId: 'home',
        readState: 'unread',
    } as const;
    return {
        openApprovals: [{ id: 'approval-1' }],
        reviewSessions: [
            { key: 'home:failed', serverId: 'home', sessionId: 'failed', session: failedSession, reason: 'failed' },
            { key: 'home:ready', serverId: 'home', sessionId: 'ready', session: readySession, reason: 'ready' },
        ],
        sessionsNeedingAttention: [{
            key: 'home:actionable',
            serverId: 'home',
            sessionId: 'actionable',
            session: actionableSession,
            reason: 'action_required',
            pendingPermissions: [],
            pendingUserActions: [],
        }],
        approvalContextByArtifactId: new Map(),
        sessionContextByKey: new Map(),
        targetBySessionKey: new Map([['home:ready', readyTarget]]),
        pendingReadKeys: new Set(),
        sessionListIdentityDisplay,
        markAllReadTargets: [readyTarget],
        markAllPending: false,
        showFriendsActivity: false,
        friendRequests: [],
        isFriendsLoading: false,
        hasContent: true,
        showCaughtUp: false,
        actionOperationModel: {
            operations: [routineOperation, actionableOperation],
            inboxEntries: [{ operation: actionableOperation, reason: 'failed' }],
        },
        markRead: vi.fn(),
        openSession: vi.fn(),
    } as unknown as InboxContentModel;
}

describe('InboxContent', () => {
    it('uses grouped sections on the full screen and keeps Mark all local to Ready for review', async () => {
        const model = createModel();
        const { InboxContent } = await import('./InboxContent');
        const screen = await renderScreen(<InboxContent model={model} />);

        const sections = screen.tree.root.findAllByType('ListSection' as never);
        expect(sections.map((section) => section.props.id)).toEqual([
            'errors',
            'ready',
            'needs-attention',
        ]);
        expect(sections.find((section) => section.props.id === 'ready')?.props.headerAction).toBeTruthy();
        expect(sections.find((section) => section.props.id === 'ready')?.props.spacing).toBe('following');
        expect(sections.find((section) => section.props.id === 'errors')?.props.headerAction).toBeUndefined();
        expect(sections.find((section) => section.props.id === 'needs-attention')?.props.headerAction).toBeUndefined();
        expect(sections.find((section) => section.props.id === 'needs-attention')?.props.spacing).toBe('separated');
        expect(sections.every((section) => section.props.surface === 'grouped')).toBe(true);
        expect(sections.some((section) => section.props.id === 'approvals')).toBe(false);
        expect(sections.find((section) => section.props.id === 'needs-attention')?.findAllByType('ApprovalInboxCard' as never)).toHaveLength(1);
        expect(screen.tree.root.findByType('Item' as never).props.density).toBe('compact');
    });

    it('keeps the popover sections flat', async () => {
        const model = createModel();
        const { InboxContent } = await import('./InboxContent');
        const screen = await renderScreen(<InboxContent model={model} presentation="popover" />);

        const sections = screen.tree.root.findAllByType('ListSection' as never);
        expect(sections.every((section) => section.props.surface === 'flat')).toBe(true);
    });

    it('renders only the canonical actionable operation projection, not routine Activity rows', async () => {
        const model = createModel();
        const { InboxContent } = await import('./InboxContent');
        const screen = await renderScreen(<InboxContent model={model} />);

        const sections = screen.tree.root.findAllByType('ListSection' as never);
        const errorSection = sections.find((section) => section.props.id === 'errors');
        const needsAttentionSection = sections.find((section) => section.props.id === 'needs-attention');
        const errorRows = errorSection?.findByType('ActionOperationRows' as never);

        expect(errorRows?.props.operations).toEqual([actionableOperation]);
        expect(errorRows?.props.presentationMode).toBe('inbox');
        expect(needsAttentionSection?.findAllByType('ActionOperationRows' as never)).toEqual([]);
        expect(screen.tree.root.findAllByType('ActionOperationLedger' as never)).toEqual([]);
    });

    it('removes the complete leading identity slot when session-list identity is disabled', async () => {
        const model = createModel('none');
        const { InboxContent } = await import('./InboxContent');
        const screen = await renderScreen(<InboxContent model={model} />);

        const actionableRow = screen.tree.root.findAllByType('Item' as never)
            .find((item) => item.props.testID === 'inbox.session_attention.home.actionable');
        expect(actionableRow?.props.leftElement).toBeUndefined();
        expect(actionableRow?.props.iconBoxSize).toBeUndefined();
    });
});
