import { describe, expect, it, vi } from 'vitest';
import { useSessionListWorkspaceHeaderActions } from './useSessionListWorkspaceHeaderActions';

const interaction = vi.hoisted(() => ({ prompt: vi.fn(async () => null), alert: vi.fn() }));
// Human prompt/alert is the UI system boundary; ref resolution and the handler stay real.
vi.mock('@/modal', () => ({ Modal: interaction }));

describe('Session workspace header enrollment boundary', () => {
  it('does not offer a ref rename as an implicit enrollment of an unaccepted Session folder', async () => {
    const actions = useSessionListWorkspaceHeaderActions({ workspaceRefs: [], collapsedGroupKeys: {}, setCollapsedGroupKeys: () => {} });
    await actions.handleRenameWorkspace({ legacyWorkspaceKey: 'legacy', currentLabel: 'Folder',
      scopeHint: { serverId: 'home', machineId: 'machine', rootPath: '/unaccepted/nested' } });
    expect(interaction.prompt).not.toHaveBeenCalled();
    expect(interaction.alert).toHaveBeenCalled();
  });
});
