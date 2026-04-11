import { describe, expect, it, vi } from 'vitest';

const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const randomUuidState = vi.hoisted(() => ({
    nextId: 1,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => action(),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => `term-project-${randomUuidState.nextId++}`,
}));

describe('openProjectTerminalDetailsTab', () => {
    it('uses a caller-provided terminal instance id so project headers can reuse the existing pinned terminal tab', async () => {
        const { openProjectTerminalDetailsTab } = await import('./openProjectTerminalDetailsTab');

        openProjectTerminalDetailsTab({
            openDetailsTab: openDetailsTabSpy,
            cwd: '/repo/worktrees/feature-auth',
            terminalInstanceId: 'project:wr_1:terminal',
        });

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            {
                key: 'terminal:project:wr_1:terminal',
                kind: 'terminal',
                title: 'settings.terminal',
                resource: {
                    kind: 'terminal',
                    terminalInstanceId: 'project:wr_1:terminal',
                    cwd: '/repo/worktrees/feature-auth',
                },
            },
            { intent: 'pinned' },
        );
    });

    it('opens a pinned project terminal details tab with a unique terminal instance and cwd', async () => {
        const { openProjectTerminalDetailsTab } = await import('./openProjectTerminalDetailsTab');

        openProjectTerminalDetailsTab({
            openDetailsTab: openDetailsTabSpy,
            cwd: '/repo/worktrees/feature-auth',
        });

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            {
                key: 'terminal:term-project-1',
                kind: 'terminal',
                title: 'settings.terminal',
                resource: {
                    kind: 'terminal',
                    terminalInstanceId: 'term-project-1',
                    cwd: '/repo/worktrees/feature-auth',
                },
            },
            { intent: 'pinned' },
        );
    });
});
