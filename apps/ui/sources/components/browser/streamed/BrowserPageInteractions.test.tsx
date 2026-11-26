import * as React from 'react';
import type { BrowserInteractionStateV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { act, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const NONE: BrowserInteractionStateV1 = { dialog: null, fileChooser: null, downloads: [] };

describe('BrowserPageInteractions', () => {
  it('publishes only download dismissal, shares the press outcome, and retires its address when dismissed', async () => {
    const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://download-controls.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { BrowserPageInteractions } = await import('./BrowserPageInteractions');
    function Publication() {
      const commands = useCurrentUiContextComposedCommands();
      usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
      return null;
    }
    const download = { downloadId: 'first', name: 'private-name.pdf', state: 'completed', receivedBytes: 10, totalBytes: 10 } as const;
    const second = { ...download, downloadId: 'second' };
    const tree = (downloads: BrowserInteractionStateV1['downloads']) => <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
      <Publication /><BrowserPageInteractions testID="downloads" pageHost={null} interaction={{ ...NONE, downloads }} />
    </CurrentUiContextCommandsProvider>;
    const screen = await renderMountedCurrentUiContext(tree([download]));
    const executor = createDefaultActionExecutor();
    const caller = { serverId: home.homes.a!.id, surface: 'agent' as const, authority: 'account_automation' as const };
    async function inventory() {
      const read = await executor.execute('ui.current_context.read', {}, caller);
      if (!read.ok) throw new Error(read.errorCode);
      return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
    }
    try {
      const commands = await inventory();
      expect(commands.map(command => command.title)).toEqual(['browserPresence.interaction.dismissDownloads']);
      expect(JSON.stringify(commands)).not.toContain(download.name);
      const address = commands[0]!.id;
      await act(async () => expect(await executor.execute('ui.current_context.command.invoke', { commandId: address }, caller)).toMatchObject({ ok: true, result: { value: null } }));
      expect(screen.findByTestId('downloads-downloads-first')).toBeNull();
      expect(await inventory()).toEqual([]);
      expect(await executor.execute('ui.current_context.command.invoke', { commandId: address }, caller)).toMatchObject({ ok: false });
      await screen.update(tree([download, second]));
      expect(screen.findByTestId('downloads-downloads-second')).not.toBeNull();
      expect((await inventory()).map(command => command.title)).toEqual(['browserPresence.interaction.dismissDownloads']);
      await screen.pressByTestIdAsync('downloads-downloads-dismiss');
      expect(screen.findByTestId('downloads-downloads-second')).toBeNull();
      expect(await inventory()).toEqual([]);
    } finally {
      await screen.unmount();
      await home.dispose();
    }
  });

  it('answers a page confirm as this viewer, and a prompt with what the person typed', async () => {
    const { BrowserPageInteractions } =
      await import('./BrowserPageInteractions');
    const answer = vi.fn();
    const screen = await renderScreen(
      <BrowserPageInteractions
        testID="page"
        pageHost="localhost:5173"
        answer={answer}
        interaction={{
          ...NONE,
          dialog: {
            dialogId: 'd1',
            type: 'confirm',
            message: 'Discard the draft?',
          },
        }}
      />,
    );
    expect(screen.getTextContent()).toContain('Discard the draft?');
    await screen.pressByTestIdAsync('page-dialog-cancel');
    expect(answer).toHaveBeenLastCalledWith({
      kind: 'dialog',
      dialogId: 'd1',
      accept: false,
    });

    await screen.update(
      <BrowserPageInteractions
        testID="page"
        pageHost="localhost:5173"
        answer={answer}
        interaction={{
          ...NONE,
          dialog: {
            dialogId: 'd2',
            type: 'prompt',
            message: 'Name it',
            defaultPrompt: 'Lumen',
          },
        }}
      />,
    );
    await screen.pressByTestIdAsync('page-dialog-ok');
    expect(answer).toHaveBeenLastCalledWith({
      kind: 'dialog',
      dialogId: 'd2',
      accept: true,
      promptText: 'Lumen',
    });
  });

  it("shows the page's question to a viewer who is not in control without offering its answers", async () => {
    const { BrowserPageInteractions } =
      await import('./BrowserPageInteractions');
    const screen = await renderScreen(
      <BrowserPageInteractions
        testID="page"
        pageHost="localhost:5173"
        interaction={{
          ...NONE,
          dialog: {
            dialogId: 'd1',
            type: 'confirm',
            message: 'Discard the draft?',
          },
        }}
      />,
    );
    expect(screen.getTextContent()).toContain('Discard the draft?');
    expect(screen.getTextContent()).toContain(
      'browserPresence.interaction.otherViewer',
    );
    expect(screen.findByTestId('page-dialog-ok')).toBeNull();
  });

  it('declines a file request with no files, and leaves the dialog first when both are open', async () => {
    const { BrowserPageInteractions } =
      await import('./BrowserPageInteractions');
    const answer = vi.fn();
    const screen = await renderScreen(
      <BrowserPageInteractions
        testID="page"
        pageHost={null}
        answer={answer}
        interaction={{
          ...NONE,
          fileChooser: { chooserId: 'c1', multiple: false },
        }}
      />,
    );
    await screen.pressByTestIdAsync('page-chooser-cancel');
    expect(answer).toHaveBeenLastCalledWith({
      kind: 'fileChooser',
      chooserId: 'c1',
      files: [],
    });

    await screen.update(
      <BrowserPageInteractions
        testID="page"
        pageHost={null}
        answer={answer}
        interaction={{
          ...NONE,
          fileChooser: { chooserId: 'c1', multiple: false },
          dialog: {
            dialogId: 'd1',
            type: 'alert',
            message: 'Pick a file next.',
          },
        }}
      />,
    );
    expect(screen.findByTestId('page-dialog')).toBeTruthy();
    expect(screen.findByTestId('page-chooser')).toBeNull();
  });

  it('lists downloads with Save once finished, hides them for this viewer, and brings back a new one', async () => {
    const { BrowserPageInteractions } =
      await import('./BrowserPageInteractions');
    const onSave = vi.fn();
    const first = {
      downloadId: 'dl1',
      name: 'invoice.pdf',
      state: 'completed',
      receivedBytes: 10,
      totalBytes: 10,
    } as const;
    const running = {
      downloadId: 'dl2',
      name: 'assets.zip',
      state: 'inProgress',
      receivedBytes: 5,
      totalBytes: 20,
    } as const;
    const screen = await renderScreen(
      <BrowserPageInteractions
        testID="page"
        pageHost={null}
        onSaveDownload={onSave}
        interaction={{ ...NONE, downloads: [first, running] }}
      />,
    );
    expect(screen.findByTestId('page-downloads-dl1-save')).toBeTruthy();
    expect(screen.findByTestId('page-downloads-dl2-save')).toBeNull();
    await screen.pressByTestIdAsync('page-downloads-dl1-save');
    expect(onSave).toHaveBeenCalledWith(first);

    await screen.pressByTestIdAsync('page-downloads-dismiss');
    expect(screen.findByTestId('page-downloads-dl1')).toBeNull();
    expect(screen.findByTestId('page-downloads-dl2')).toBeNull();
    const next = {
      downloadId: 'dl3',
      name: 'report.csv',
      state: 'inProgress',
      receivedBytes: 0,
      totalBytes: 0,
    } as const;
    await screen.update(
      <BrowserPageInteractions
        testID="page"
        pageHost={null}
        onSaveDownload={onSave}
        interaction={{ ...NONE, downloads: [first, running, next] }}
      />,
    );
    expect(screen.findByTestId('page-downloads-dl3')).toBeTruthy();
    expect(screen.findByTestId('page-downloads-dl1')).toBeNull();
  });
});
