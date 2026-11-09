import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceFileEditorHeaderModel } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorHeaderModel';
import { resolveFileEditorNoticeLine } from './fileEditorNoticeLineModel';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

function editor(
  patch: Partial<WorkspaceFileEditorHeaderModel> = {},
): WorkspaceFileEditorHeaderModel {
  return {
    status: 'dirty',
    saved: false,
    savedAtMs: null,
    refusal: null,
    conflict: null,
    canSave: true,
    shortcutLabel: undefined,
    draftPersistenceFailed: false,
    lineEndingNormalization: null,
    onSave: vi.fn(),
    onDone: vi.fn(),
    onCancel: vi.fn(),
    onStart: vi.fn(),
    onCompare: vi.fn(),
    onResolve: vi.fn(),
    ...patch,
  };
}

const online = { unreachable: false, machineName: 'MacBook Pro' };
const offline = { unreachable: true, machineName: 'MacBook Pro' };
const conflict = {
  theirsText: 'theirs',
  theirsHash: 'h2',
} as WorkspaceFileEditorHeaderModel['conflict'];

function resolve(
  model: WorkspaceFileEditorHeaderModel,
  reachability = online,
  agentName: string | null = 'Claude',
) {
  return resolveFileEditorNoticeLine({
    editor: model,
    editing: true,
    reachability,
    agentName,
    onRetryReachability: vi.fn(),
  });
}

describe('file editor notice line', () => {
  it('shows nothing while not editing or while editing is healthy', () => {
    expect(
      resolveFileEditorNoticeLine({
        editor: editor({ conflict }),
        editing: false,
        reachability: offline,
        agentName: null,
        onRetryReachability: vi.fn(),
      }),
    ).toBeNull();
    expect(resolve(editor())).toBeNull();
  });

  it('puts the agent write first, with Compare as the forward step and both resolutions wired to the owner', () => {
    const model = editor({ conflict, refusal: { kind: 'unreachable' } });
    const line = resolve(model, offline);
    expect(line?.key).toBe('conflict');
    expect(line?.tone).toBe('warning');
    expect(line?.actions.map((action) => action.emphasis ?? null)).toEqual([
      'primary',
      null,
      null,
    ]);
    line?.actions[1]?.onPress();
    line?.actions[2]?.onPress();
    expect(model.onResolve).toHaveBeenNthCalledWith(1, 'useMine');
    expect(model.onResolve).toHaveBeenNthCalledWith(2, 'useTheirs');
    // Without a known writer the copy names the disk, not a hard-coded agent.
    expect(resolve(model, offline, null)?.emphasis).toBe(
      'files.editing.conflictOnDisk',
    );
  });

  it('keeps editing calm while the Machine is away, then offers Save as the one primary when it is back', () => {
    const away = resolve(editor({ refusal: { kind: 'unreachable' } }), offline);
    expect(away?.key).toBe('offline');
    expect(away?.tone).toBe('neutral');
    const back = resolve(editor({ refusal: { kind: 'unreachable' } }), online);
    expect(back?.key).toBe('back');
    expect(back?.actions).toHaveLength(1);
    expect(back?.actions[0]?.emphasis).toBe('primary');
    // Nothing left to save: the back line has nothing to offer.
    expect(
      resolve(
        editor({ status: 'clean', refusal: { kind: 'unreachable' } }),
        online,
      ),
    ).toBeNull();
  });

  it('says a save already pressed while the Machine is away goes through when it is back', () => {
    const waiting = resolve(editor({ status: 'saving' }), offline);
    expect(waiting?.key).toBe('offline');
    // The pill reads Saving: the line must not still ask the person to save later.
    expect(waiting?.reason).toBe('files.editing.offlineSaving(machine=MacBook Pro)');
    expect(resolve(editor({ status: 'dirty' }), offline)?.reason).toBe('files.editing.offline(machine=MacBook Pro)');
  });

  it('says a save waits for approval before anything about reachability', () => {
    expect(
      resolve(editor({ refusal: { kind: 'awaitingApproval' } }), offline)?.key,
    ).toBe('approval');
  });

  it('leads a waiting save to its approval review once the request exists', () => {
    const onOpenApproval = vi.fn();
    const line = resolveFileEditorNoticeLine({
      editor: editor({ refusal: { kind: 'awaitingApproval' } }),
      editing: true, reachability: online, agentName: 'Claude', onRetryReachability: vi.fn(), onOpenApproval,
    });
    expect(line?.actions).toHaveLength(1);
    line?.actions[0]?.onPress();
    expect(onOpenApproval).toHaveBeenCalledTimes(1);
    expect(resolve(editor({ refusal: { kind: 'awaitingApproval' } }))?.actions).toEqual([]);
  });

  it('falls back to the quiet notes only when no cause needs the person', () => {
    expect(
      resolve(
        editor({ refusal: { kind: 'failed' }, draftPersistenceFailed: true }),
      )?.key,
    ).toBe('failed');
    expect(
      resolve(
        editor({ draftPersistenceFailed: true, lineEndingNormalization: 'lf' }),
      )?.key,
    ).toBe('draft');
    expect(resolve(editor({ lineEndingNormalization: 'crlf' }))?.key).toBe(
      'eol',
    );
  });
});
