import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { hitAreaClippingAncestors } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('ActionApprovalPendingNotice', () => {
    it('names what is waiting and offers Review, as a row and inline in a host bar', async () => {
        const { ActionApprovalPendingNotice } = await import('./ActionApprovalPendingNotice');
        const open = vi.fn();
        const row = await renderScreen(<ActionApprovalPendingNotice message="approvals.status.open" testID="notice"
            summary="Write docs/getting-started.md in d-dc-hello-world." onOpenApproval={open} />);
        const rowText = row.getTextContent();
        expect(rowText).toContain('Write docs/getting-started.md in d-dc-hello-world');
        expect(rowText).toContain('approvals.waitingForYou');
        expect(rowText).toContain('approvals.review');
        expect(rowText).not.toContain('approvals.status.open');

        const inline = await renderScreen(<ActionApprovalPendingNotice presentation="inline" message="approvals.status.open"
            testID="inline-notice" summary="Write docs/getting-started.md in d-dc-hello-world." onOpenApproval={open} />);
        expect(inline.getTextContent()).toContain('Write docs/getting-started.md in d-dc-hello-world');
        await inline.pressByTestIdAsync('inline-notice');
        expect(open).toHaveBeenCalledOnce();
    });

    it('lets a finger reach the inline pill past its drawn edge (its words truncate without clipping the press target)', async () => {
        const { ActionApprovalPendingNotice } = await import('./ActionApprovalPendingNotice');
        const inline = await renderScreen(<ActionApprovalPendingNotice presentation="inline" message="approvals.status.open"
            testID="inline-notice" summary="Write docs/getting-started.md in d-dc-hello-world." onOpenApproval={() => {}} />);
        expect(hitAreaClippingAncestors(inline.findHostByTestId('inline-notice')!).map((node) => String(node.props.testID ?? node.type))).toEqual([]);
    });
});
