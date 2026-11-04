import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

import { ConnectedAccountRenamePopover } from './ConnectedAccountRenamePopover';

describe('Connected Account rename', () => {
    it('accepts a full account label beyond eighty characters', async () => {
        const label = 'Personal development account · '.repeat(4);
        const onSave = vi.fn();
        const screen = await renderScreen(<ConnectedAccountRenamePopover open anchorRef={React.createRef()}
            currentLabel="Personal" serviceLabel="Subscription" testID="rename"
            onRequestClose={() => undefined} onSave={onSave} />);
        expect(screen.findHostByTestId('rename:input')?.props.maxLength).toBeUndefined();
        await act(async () => screen.changeTextByTestId('rename:input', label));
        await screen.pressByTestIdAsync('rename:save');
        expect(onSave).toHaveBeenCalledWith(label.trim());
    });

    it('submits a trimmed blank label and retains pending-save admission', async () => {
        const pending = createDeferred<void>();
        const labels: string[] = [];
        const screen = await renderScreen(<ConnectedAccountRenamePopover open anchorRef={React.createRef()}
            currentLabel="Personal" serviceLabel="Subscription" testID="rename"
            onRequestClose={() => undefined} onSave={async label => { labels.push(label); await pending.promise; }} />);
        await act(async () => { screen.tree.changeTextByTestId('rename:input', '   '); });
        expect(screen.tree.findByTestId('rename:save')?.props.disabled).toBe(false);
        await act(async () => { screen.tree.pressByTestId('rename:save'); });
        expect(labels).toEqual(['']);
        expect(screen.tree.findByTestId('rename:save')?.props.disabled).toBe(true);
        await act(async () => { pending.resolve(); });
        expect(screen.tree.findByTestId('rename:save')?.props.disabled).toBe(false);
    });
});
