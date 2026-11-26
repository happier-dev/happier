import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ImageMarksDocumentV1Schema, type ImageMarkV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createImageAnnotator } from './annotatorStore';
import { useImageAnnotatorState } from './useImageAnnotator';
import { AnnotatorPalette } from './AnnotatorPalette';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { t } from '@/text';

// The renderer supplies no native popover anchor measurement; keep its mounted content inline.
vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
    { maxHeight: 600, maxWidth: 400, placement: 'bottom' }));

describe('annotation subscription cost', () => {
  it('publishes the visible annotation tools and style choices without waking unchanged marks', async () => {
    const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://annotation-controls.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const annotator = createImageAnnotator({ source: { uri: 'blob:annotation', width: 1000, height: 600, scale: 1 }, tools: { crop: false } });
    const initial = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 1000, height: 600, scale: 1 },
      marks: Array.from({ length: 200 }, (_, index) => ({ id: String(index), kind: 'rectangle', rect: { x: 1, y: 2, width: 20, height: 30 }, color: 'red', size: 'm' })) });
    annotator.receiveDocument(initial);
    const counters = initial.marks.map(() => createRenderCommitCounter());
    const Mark = React.memo(function Mark({ mark }: Readonly<{ mark: ImageMarkV1 }>) {
      useRenderCommitCounter(counters[Number(mark.id)]!);
      return null;
    });
    function Host({ show = true, phone = false }: Readonly<{ show?: boolean; phone?: boolean }>) {
      const commands = useCurrentUiContextComposedCommands();
      usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
      const marks = useImageAnnotatorState(annotator, state => state.document.marks);
      return <>{marks.map(mark => <Mark key={mark.id} mark={mark} />)}
        {show ? <AnnotatorPalette annotator={annotator} layout={phone ? 'phone' : 'bar'} surface="paper" /> : null}</>;
    }
    const screen = await renderMountedCurrentUiContext(<Host />);
    const executor = createDefaultActionExecutor();
    const caller = { serverId: server.id, surface: 'agent' as const, authority: 'account_automation' as const };
    async function inventory() {
      const read = await executor.execute('ui.current_context.read', {}, caller);
      if (!read.ok) throw new Error(read.errorCode);
      return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
    }
    async function invoke(title: string) {
      const command = (await inventory()).find(row => row.title === title);
      expect(command, title).toBeDefined();
      await act(async () => expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, caller)).toMatchObject({ ok: true }));
      return command!.id;
    }
    const toolTitles = (['select', 'arrow', 'rectangle', 'ellipse', 'freehand', 'highlighter', 'text', 'step', 'blur'] as const)
      .map(tool => t(`files.annotate.tools.${tool}`));
    const styleTitles = [
      ...(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'ink'] as const).map(color => t(`files.annotate.colours.${color}`)),
      ...(['s', 'm', 'l'] as const).map(size => t(`files.annotate.stroke.${size}`)),
    ];
    try {
      counters.forEach(counter => counter.reset());
      await act(async () => annotator.setStyle({ color: 'blue' }));
      expect(counters.map(counter => counter.read())).toEqual(initial.marks.map(() => ({ renders: 0, commits: 0 })));
      expect((await inventory()).map(row => row.title).sort()).toEqual([...toolTitles, t('files.annotate.colourAndStroke')].sort());
      const address = await invoke(t('files.annotate.tools.rectangle'));
      expect(annotator.store.getState().tool).toBe('rectangle');
      await screen.pressByTestIdAsync('annotator-tool-arrow');
      expect(annotator.store.getState().tool).toBe('arrow');
      await invoke(t('files.annotate.colourAndStroke'));
      expect((await inventory()).map(row => row.title).sort()).toEqual([...toolTitles, t('files.annotate.colourAndStroke'), ...styleTitles].sort());
      const staleStyle = await invoke(t('files.annotate.colours.green'));
      expect(annotator.store.getState().style.color).toBe('green');
      await screen.pressByTestIdAsync('annotator-swatch-red');
      expect(annotator.store.getState().style.color).toBe('red');
      await invoke(t('files.annotate.colourAndStroke'));
      expect(await executor.execute('ui.current_context.command.invoke', { commandId: staleStyle }, caller)).toMatchObject({ ok: false });
      await invoke(t('files.annotate.tools.text'));
      await invoke(t('files.annotate.colourAndStroke'));
      expect((await inventory()).map(row => row.title).sort()).toEqual([
        ...toolTitles, t('files.annotate.colourAndStroke'),
        ...(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'ink'] as const).map(color => t(`files.annotate.colours.${color}`)),
        ...(['s', 'm', 'l'] as const).map(size => t(`files.annotate.textSize.${size}`)),
      ].sort());
      await invoke(t('files.annotate.textSize.s'));
      expect(annotator.store.getState().style.size).toBe('s');
      await invoke(t('files.annotate.colourAndStroke'));
      await screen.update(<Host phone />);
      expect((await inventory()).map(row => row.title).sort()).toEqual([...toolTitles, ...styleTitles].sort());
      await invoke(t('files.annotate.colours.green'));
      expect(annotator.store.getState().style.color).toBe('green');
      await screen.pressByTestIdAsync('annotator-swatch-red');
      expect(annotator.store.getState().style.color).toBe('red');
      await invoke(t('files.annotate.stroke.l'));
      expect(annotator.store.getState().style.size).toBe('l');
      await screen.update(<Host show={false} />);
      expect(await inventory()).toEqual([]);
      expect(await executor.execute('ui.current_context.command.invoke', { commandId: address }, caller)).toMatchObject({ ok: false });
      expect(counters.map(counter => counter.read())).toEqual(initial.marks.map(() => ({ renders: 0, commits: 0 })));
    } finally {
      await screen.unmount();
      await home.dispose();
    }
  });

  it('adds one mark render to 200 committed marks without waking their unchanged renderers', async () => {
    const examples: readonly ImageMarkV1[] = [
      { id: '', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 20, y: 30 }, color: 'red', size: 'm' },
      { id: '', kind: 'rectangle', rect: { x: 0, y: 0, width: 20, height: 30 }, color: 'red', size: 'm' },
      { id: '', kind: 'ellipse', rect: { x: 0, y: 0, width: 20, height: 30 }, color: 'red', size: 'm' },
      { id: '', kind: 'freehand', points: [{ x: 0, y: 0 }, { x: 20, y: 30 }], color: 'red', size: 'm' },
      { id: '', kind: 'highlighter', points: [{ x: 0, y: 0 }, { x: 20, y: 30 }], color: 'yellow', size: 'm' },
      { id: '', kind: 'text', at: { x: 0, y: 0 }, text: 'Note', color: 'red', size: 'm' },
      { id: '', kind: 'step', at: { x: 0, y: 0 }, color: 'red', size: 'm' },
      { id: '', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 30 }, size: 'm' },
      { id: '', kind: 'element', rect: { x: 0, y: 0, width: 20, height: 30 }, color: 'red', label: 'button' },
    ];
    const initial = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 1000, height: 600, scale: 1 }, marks: Array.from({ length: 200 }, (_, i) => ({ ...examples[i % examples.length], id: String(i) })) });
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', ...initial.image }, initial });
    const counters = Array.from({ length: 201 }, () => createRenderCommitCounter());
    const styleCounter = createRenderCommitCounter();
    const Mark = React.memo(function Mark({ mark }: Readonly<{ mark: ImageMarkV1 }>) {
      useRenderCommitCounter(counters[Number(mark.id)]!);
      return null;
    });
    function Marks() {
      const marks = useImageAnnotatorState(annotator, state => state.document.marks);
      return <>{marks.map(mark => <Mark key={mark.id} mark={mark} />)}</>;
    }
    function StyleObserver() {
      useImageAnnotatorState(annotator, state => state.style);
      useRenderCommitCounter(styleCounter);
      return null;
    }
    const screen = await renderScreen(<><Marks /><StyleObserver /></>);
    try {
      counters.forEach(counter => counter.reset()); styleCounter.reset();
      await act(async () => annotator.apply([{ kind: 'mark.add', mark: { id: '200', kind: 'rectangle', rect: { x: 5, y: 6, width: 20, height: 30 }, color: 'blue', size: 's' } }]));
      expect(counters.slice(0, 200).map(counter => counter.read())).toEqual(Array.from({ length: 200 }, () => ({ renders: 0, commits: 0 })));
      expect(counters[200]!.read()).toEqual({ renders: 1, commits: 1 });
      expect(styleCounter.read()).toEqual({ renders: 0, commits: 0 });
    } finally { await screen.unmount(); }
  });
});
