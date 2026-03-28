import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: (props: Record<string, unknown>) =>
        React.createElement('SessionRepositoryTreeBrowserView', props),
}));

vi.mock('@/components/ui/pathBrowser/MachinePathBrowserModal', () => ({
    MachinePathBrowserView: (props: Record<string, unknown>) =>
        React.createElement('MachinePathBrowserView', props),
}));

describe('LinkFilePickerPopoverContent', () => {
    it('uses the session repository tree browser when a session id is available', async () => {
        const { LinkFilePickerPopoverContent } = await import('./LinkFilePickerPopoverContent');
        const onPickPath = vi.fn();
        const onRequestClose = vi.fn();

        const screen = await renderScreen(
            <LinkFilePickerPopoverContent
                sessionId="s1"
                onPickPath={onPickPath}
                onRequestClose={onRequestClose}
            />,
        );

        const browser = screen.findByType('SessionRepositoryTreeBrowserView');
        expect(browser).toBeTruthy();
        expect(browser?.props.sessionId).toBe('s1');

        browser?.props.onOpenFile('src/example.ts');
        expect(onPickPath).toHaveBeenCalledWith('src/example.ts');
        expect(onRequestClose).toHaveBeenCalled();
    });

    it('wraps the session repository tree browser with an explicit height when a maxHeight is provided (prevents 0-height popovers)', async () => {
        const { LinkFilePickerPopoverContent } = await import('./LinkFilePickerPopoverContent');

        const screen = await renderScreen(
            <LinkFilePickerPopoverContent
                sessionId="s1"
                maxHeight={333}
                onPickPath={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const wrapper = screen.findByTestId('link-file-picker-session-wrapper');
        expect(wrapper).toBeTruthy();
        expect(wrapper?.props?.style).toEqual(expect.objectContaining({ height: 333 }));
    });

    it('uses the machine path browser when scoped to a new-session root directory', async () => {
        const { LinkFilePickerPopoverContent } = await import('./LinkFilePickerPopoverContent');
        const onPickPath = vi.fn();
        const onRequestClose = vi.fn();

        const screen = await renderScreen(
            <LinkFilePickerPopoverContent
                machineId="m1"
                serverId="srv-1"
                rootDirectoryPath="/repo"
                onPickPath={onPickPath}
                onRequestClose={onRequestClose}
            />,
        );

        const browser = screen.findByType('MachinePathBrowserView');
        expect(browser).toBeTruthy();
        expect(browser?.props.machineId).toBe('m1');
        expect(browser?.props.serverId).toBe('srv-1');
        expect(browser?.props.rootDirectoryPath).toBe('/repo');
        expect(browser?.props.selectionMode).toBe('file');
        expect(browser?.props.variant).toBe('popover');
        expect(browser?.props.interaction).toBe('immediate');

        browser?.props.onPickPath('/repo/src/example.ts');
        expect(onPickPath).toHaveBeenCalledWith('/repo/src/example.ts');
        expect(onRequestClose).toHaveBeenCalled();
    });

    it('wraps the machine path browser with an explicit height when a maxHeight is provided (prevents 0-height popovers)', async () => {
        const { LinkFilePickerPopoverContent } = await import('./LinkFilePickerPopoverContent');

        const screen = await renderScreen(
            <LinkFilePickerPopoverContent
                machineId="m1"
                rootDirectoryPath="/repo"
                maxHeight={444}
                onPickPath={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const wrapper = screen.findByTestId('link-file-picker-machine-wrapper');
        expect(wrapper).toBeTruthy();
        expect(wrapper?.props?.style).toEqual(expect.objectContaining({ height: 444 }));
    });
});
