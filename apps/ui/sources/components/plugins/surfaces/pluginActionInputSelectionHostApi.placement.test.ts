import { afterEach, expect, it, vi } from 'vitest';
import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SelectionListProps } from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPluginActionInputSelectionHostApiHandler } from './pluginActionInputSelectionHostApi';

// Native modal lifecycle is the platform boundary, using the incumbent presentation test seam.
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), hide: vi.fn() } }));

const candidates = [
    { projectKey: { id: 'project-a' }, serverId: 'server-a', machineId: 'machine-a', rootPath: '/first', reachable: true, worktrees: [] },
    { projectKey: { id: 'project-b' }, serverId: 'server-a', machineId: 'machine-a', rootPath: '/chosen', reachable: true, worktrees: [] },
];
const request: PluginUiHostApiRequestEnvelopeV1 = { version: 1, requestId: 'placement', surface: {
    pluginId: 'acme.pr', contributionId: 'pr', surfaceId: 'project-pr', placement: 'appSurface',
    platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
}, method: 'selectActionInput', payload: {
    hostAction: { action: 'session.spawn_new', projection: 'sessionPlacement' }, candidates,
} };
function mount() {
    const controller = new AbortController();
    const lifetime = { scope: { serverId: 'server-a', accountId: 'account-a' }, isCurrent: () => !controller.signal.aborted,
        onRetire: () => ({ dispose() {} }) };
    return { controller, handler: createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'server-a', machineId: 'machine-a', targetPluginId: 'acme.pr', accountLifetime: lifetime, signal: controller.signal,
    }, isCurrent: lifetime.isCurrent }) };
}
afterEach(() => vi.restoreAllMocks());

it('asks for a saved project through the incumbent New Session picker without an Agent recipe', async () => {
    const shown = createDeferred<SelectionListProps>();
    // Modal presentation is the person/platform boundary; request, result and picker logic stay real.
    vi.spyOn(Modal, 'show').mockImplementation(config => { shown.resolve(config.props as SelectionListProps); return 'placement-picker'; });
    vi.spyOn(Modal, 'hide').mockImplementation(() => {});
    const pending = mount().handler(request);
    const props = await shown.promise;
    const section = props.rootStep.sections[0];
    if (section?.kind !== 'static') throw new Error('expected saved project choices');
    expect(section.options).toHaveLength(2);
    section.options[1]?.onSelect?.();
    expect(await pending).toEqual({ kind: 'sessionPlacement', candidate: candidates[1] });
});

it('does not invent a placement when no saved project is available', async () => {
    const show = vi.spyOn(Modal, 'show');
    expect(await mount().handler({ ...request, payload: {
        hostAction: { action: 'session.spawn_new', projection: 'sessionPlacement' }, candidates: [],
    } })).toMatchObject({ code: 'unavailable', diagnostics: ['saved_project_required'] });
    expect(show).not.toHaveBeenCalled();
});

it('retires a pending placement picker when its Account retires', async () => {
    const shown = createDeferred<void>();
    vi.spyOn(Modal, 'show').mockImplementation(() => { shown.resolve(); return 'placement-picker'; });
    const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
    const mounted = mount();
    const pending = mounted.handler(request);
    await shown.promise;
    mounted.controller.abort();
    expect(await pending).toMatchObject({ code: 'stale_surface' });
    expect(hide).toHaveBeenCalledWith('placement-picker');
});
