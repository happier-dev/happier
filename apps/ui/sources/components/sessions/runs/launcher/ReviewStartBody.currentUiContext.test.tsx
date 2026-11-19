import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { ReviewStartBody } from './ReviewStartBody';
import { useExecutionRunLauncherDraft } from './useExecutionRunLauncherDraft';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
    vi.unstubAllGlobals();
});

it('edits the mounted Review controls through semantic commands and the existing launcher draft', async () => {
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://review-draft-command.test', accountId: 'account-a' }],
        route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    let draftInput: Record<string, unknown> = {};
    function Draft({ disabled = false }: Readonly<{ disabled?: boolean }>) {
        const lifetime = useActiveServerAccountScopeLifetime();
        const draft = useExecutionRunLauncherDraft({ lifetime, sessionId: null, draftKey: 'review', actionId: 'review.start',
            createDefaultInput: () => ({ reviewers: [{ kind: 'engine', engineId: 'claude' }], then: 'report', outputs: [] }) });
        draftInput = draft.actionInput;
        return <ReviewStartBody input={draft.actionInput} onChange={draft.setUserActionInput}
            source={{ enabled: true, where: null, sections: [], selectedIds: new Set() }} choices={[]}
            transcriptAvailable walkthrough={Array.isArray(draft.actionInput.outputs) && draft.actionInput.outputs.includes('walkthrough')}
            disabled={disabled} />;
    }
    const screen = await renderMountedCurrentUiContext(<Draft />);
    const executor = createDefaultActionExecutor();
    const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
    const invoke = async (control: string, input?: PluginUiJsonValueV1) => {
        const command = commands().find(row => row.description?.startsWith(control));
        expect(command, control).toBeDefined();
        let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
        await act(async () => { result = await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], {
            commandId: command!.id, ...(input === undefined ? {} : { input }),
        }, { surface: 'agent' }); });
        return result;
    };

    expect(screen.findByTestId('review-start-step:0:focus')).not.toBeNull();
    expect(await invoke('review.start.step.0.focus', { value: 'Check account isolation' })).toMatchObject({ ok: true });
    expect(screen.findByTestId('review-start-step:0:focus')?.props.value).toBe('Check account isolation');
    expect(await invoke('review.start.step.0.transcript', { value: true })).toMatchObject({ ok: true });
    expect(screen.tree.findAllByType(Item).find(row => row.props.testID === 'review-start-step:0:transcript')!
        .findByType(Switch).props.value).toBe(true);
    expect(await invoke('review.start.steps.add')).toMatchObject({ ok: true });
    expect(await invoke('review.start.step.1.kind', { value: 'review' })).toMatchObject({ ok: true });
    expect(screen.tree.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'review-start-step:1:menu:list')!
        .props.items.find((item: { id: string }) => item.id === 'review').checked).toBe(true);
    expect(await invoke('review.start.then', { value: 'fix' })).toMatchObject({ ok: true });
    expect(screen.tree.findByType(SegmentedChoiceItem).props.value).toBe('fix');
    expect(await invoke('review.start.walkthrough', { value: true })).toMatchObject({ ok: true });
    expect(screen.tree.findAllByType(Item).find(row => row.props.testID === 'review-start-walkthrough')!
        .findByType(Switch).props.value).toBe(true);
    await screen.pressByTestIdAsync('review-start-walkthrough');
    expect(draftInput.outputs).toEqual([]);
    expect(draftInput).toMatchObject({ then: 'fix', steps: [
        { kind: 'review', instructions: 'Check account isolation', reviewers: [{ includeSessionTranscript: true }] },
        { kind: 'review', instructions: '', reviewers: [] },
    ] });
    expect(await invoke('review.start.step.0.focus', { value: 42 })).toMatchObject({ ok: false });
    const stale = commands().find(row => row.description?.startsWith('review.start.step.1.kind'))!;
    expect(await invoke('review.start.step.1.remove')).toMatchObject({ ok: true });
    expect(screen.findByTestId('review-start-step:1:focus')).toBeNull();
    expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], {
        commandId: stale.id, input: { value: 'verify' },
    }, { surface: 'agent' })).toMatchObject({ ok: false });
    await screen.update(<Draft disabled />);
    expect(commands().some(row => row.description?.startsWith('review.start.'))).toBe(false);
});
