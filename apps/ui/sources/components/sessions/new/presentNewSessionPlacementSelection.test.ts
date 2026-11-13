import { afterEach, expect, it, vi } from 'vitest';
import type { SelectionListProps } from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import { presentNewSessionPlacementSelection } from './presentNewSessionPlacementSelection';

// Native modal lifecycle is the platform boundary, using the incumbent presentation test seam.
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), hide: vi.fn() } }));

afterEach(() => vi.restoreAllMocks());

it('settles as dismissed when the picker list itself asks to close (Close command / Escape)', async () => {
    let props: SelectionListProps | undefined;
    vi.spyOn(Modal, 'show').mockImplementation(config => { props = config.props as SelectionListProps; return 'placement-picker'; });
    const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
    const presentation = presentNewSessionPlacementSelection([
        { projectKey: { id: 'project-a' }, serverId: 'server-a', machineId: 'machine-a', rootPath: '/a', reachable: true, worktrees: [] },
    ]);
    // SelectionList routes its own Close command and Escape through `onRequestClose`.
    props?.onRequestClose();
    expect(await presentation.result).toBeNull();
    expect(hide).toHaveBeenCalledWith('placement-picker');
});
