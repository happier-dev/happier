import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    contentProps: null as Record<string, unknown> | null,
}));
const inboxModel = vi.hoisted(() => ({
    sessionPresentation: {
        markAllReadTargets: [],
        sessionsNeedingAttention: [] as unknown[],
        readySessions: [] as unknown[],
    },
    markAllPending: false,
    markRead: vi.fn(),
    openApprovals: [] as unknown[],
    openUsageNotices: [],
    actionOperationEntries: [],
    friendRequests: [],
    workflowAttention: { runIds: [] as string[] },
    workGroups: [],
}));
const boundaryState = vi.hoisted(() => ({ mounts: 0 }));

vi.mock('@/hooks/inbox/useInboxModel', () => ({
    InboxModelBoundary: (props: { children: React.ReactNode }) => {
        boundaryState.mounts += 1;
        return props.children;
    },
    useInboxModel: () => inboxModel,
}));

vi.mock('./InboxContent', () => ({
    InboxContent: (props: Record<string, unknown>) => {
        capture.contentProps = props;
        return React.createElement('InboxContent', props);
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('InboxPopoverContent (lab inbox-I2)', () => {
    beforeEach(() => {
        boundaryState.mounts = 0;
        capture.contentProps = null;
    });

    it('names itself, offers Open Inbox as its one header action, and closes before every navigation', async () => {
        const order: string[] = [];
        const close = vi.fn(() => order.push('close'));
        const onOpenInbox = vi.fn(() => order.push('open'));
        const { InboxPopoverContent } = await import('./InboxPopover');
        const screen = await renderScreen(<InboxPopoverContent close={close} onOpenInbox={onOpenInbox} />);

        expect(boundaryState.mounts).toBe(1);
        expect(capture.contentProps?.onBeforeNavigate).toBe(close);
        expect(capture.contentProps?.presentation).toBe('popover');
        expect(screen.getTextContent()).toContain('tabs.inbox');
        expect(screen.findByTestId('inbox.popover.mark_all_read')).toBeNull();
        expect(screen.findByTestId('inbox.popover.open')).not.toBeNull();

        act(() => screen.pressByTestId('inbox.popover.open'));
        expect(order).toEqual(['close', 'open']);
    });

    it('shows the same count as the rail badge that opened it: what needs you plus the updates', async () => {
        inboxModel.openApprovals = [{}];
        inboxModel.workflowAttention.runIds = ['run-1'];
        inboxModel.sessionPresentation.readySessions = [{}, {}];
        try {
            const { InboxPopoverContent } = await import('./InboxPopover');
            const screen = await renderScreen(<InboxPopoverContent close={() => {}} onOpenInbox={() => {}} />);
            expect(screen.findByTestId('inbox.popover.count')?.props.children).toBe('4');
        } finally {
            inboxModel.openApprovals = [];
            inboxModel.workflowAttention.runIds = [];
            inboxModel.sessionPresentation.readySessions = [];
        }
    });
});
