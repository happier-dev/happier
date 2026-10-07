import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Native layout is the system boundary; the shared preview and its projection stay real.
vi.mock('react-native', () => ({ View: 'View' }));

import { HappierArtifactPreviewCard, type HappierArtifactPreview, type HappierArtifactPreviewCardProps } from './ArtifactPreviewCard.js';

const colors = { primary: 'black', secondary: 'gray', tertiary: 'gray', paper: 'white', paperBorder: 'gray' };
let textRenders = 0;
let commits = 0;
const host: HappierArtifactPreviewCardProps['host'] = {
  renderText: input => { textRenders += 1; return <span>{input.text}</span>; },
  renderIcon: input => <span>{input.name}</span>,
};
const boardLabels = { layout: 'Canvas', sources: 'Needs you, My machines', widgetCount: '1000 widgets',
  widget: 'Widget', widthOne: 'One column', widthTwo: 'Two columns' };
let tree: ReactTestRenderer;
let bandHeight = 0;

afterEach(async () => { if (tree) await act(async () => tree.unmount()); });

function card(preview: HappierArtifactPreview) {
  return <React.Profiler id="preview" onRender={() => { commits += 1; }}>
    <HappierArtifactPreviewCard preview={preview} colors={colors} host={host}
      htmlLabel="Document" boardLabels={preview.kind === 'board' ? boardLabels : undefined} testID="preview" />
  </React.Profiler>;
}

function previewBand() {
  return tree.root.find(node => node.type === 'View' && node.props.testID === 'preview');
}

function rows() {
  return previewBand().findAll(node => node.type === 'View'
    && node.props.style?.flexDirection === 'row');
}

async function layoutBand(height: number) {
  bandHeight = height;
  const band = previewBand();
  if (band.props.onLayout) await act(async () => band.props.onLayout({ nativeEvent: { layout: { height, width: 260, x: 0, y: 0 } } }));
}

async function layoutRows(rowHeight: number, summaryHeight?: number) {
  if (summaryHeight !== undefined) {
    const summary = previewBand().findAll(node => node.type === 'View'
      && node.props.style?.gap === 6 && node.props.style?.flexDirection === undefined)[0];
    if (summary?.props.onLayout) await act(async () => summary.props.onLayout({ nativeEvent: { layout: { height: summaryHeight, width: 228, x: 16, y: 14 } } }));
  }
  // Deliver actual heights needed to settle the visible prefix, not off-band row events.
  let measured = 0;
  const rowTop = (index: number) => 14 + (summaryHeight === undefined ? 0 : summaryHeight + 6) + index * (rowHeight + 6);
  while (measured < rows().length && rowTop(measured) < bandHeight) {
    const row = rows()[measured]!;
    if (!row.props.onLayout) return;
    await act(async () => row.props.onLayout({ nativeEvent: { layout: { height: rowHeight, width: 228, x: 16, y: rowTop(measured) } } }));
    measured += 1;
  }
}

describe('HappierArtifactPreviewCard visible structure', () => {
  it('mounts only steps intersecting the measured band, including its partially visible last row', async () => {
    const preview = { kind: 'workflow', steps: Array.from({ length: 1000 }, (_, index) => ({ title: `Step ${index + 1}` })) } as const;
    textRenders = 0;
    commits = 0;
    await act(async () => { tree = create(card(preview)); });
    await layoutBand(128);
    await layoutRows(16);
    console.info('workflow preview measurement', { saved: preview.steps.length, rendered: rows().length, textRenders, commits });
    expect(rows()).toHaveLength(6);
    expect(JSON.stringify(tree.toJSON())).toContain('Step 6');
    expect(JSON.stringify(tree.toJSON())).not.toContain('Step 7');
    expect(preview.steps).toHaveLength(1000);
  });

  it('uses wrapped and scaled row heights, and fills a larger band without a fixed step cap', async () => {
    const preview = { kind: 'workflow', steps: Array.from({ length: 1000 }, (_, index) => ({ title: `Step ${index + 1}` })) } as const;
    await act(async () => { tree = create(card(preview)); });
    await layoutBand(128);
    await layoutRows(16);
    expect(rows()).toHaveLength(6);
    await layoutRows(40);
    expect(rows()).toHaveLength(3);
    await layoutBand(512);
    await layoutRows(40);
    expect(rows()).toHaveLength(11);
    await layoutBand(40);
    expect(rows()).toHaveLength(1);
  });

  it('keeps full Board summary, widths, positions and sources while only mounting visible widgets', async () => {
    const preview: HappierArtifactPreview = { kind: 'board', layout: { mode: 'canvas',
      source: { sections: ['needs_you', 'my_machines'], hasFilter: false, pickedCount: 0 },
      widgets: Array.from({ length: 1000 }, (_, index) => ({ title: `Widget ${index + 1}`, width: 2 as const, position: { x: index, y: index + 1 } })),
    } };
    textRenders = 0;
    commits = 0;
    await act(async () => { tree = create(card(preview)); });
    await layoutBand(128);
    await layoutRows(16, 36);
    console.info('board preview measurement', { saved: preview.layout.widgets.length, rendered: rows().length, textRenders, commits });
    expect(rows()).toHaveLength(4);
    const rendered = JSON.stringify(tree.toJSON());
    for (const value of ['1000 widgets', 'Needs you, My machines', 'Canvas', 'Widget 4', 'Two columns', '(3, 4)']) expect(rendered).toContain(value);
    expect(rendered).not.toContain('Widget 5');
    expect(preview.layout.widgets).toHaveLength(1000);
    expect(previewBand().props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('remeasures a replacement structure rather than reusing the previous labels geometry', async () => {
    const preview = { kind: 'workflow', steps: Array.from({ length: 10 }, (_, index) => ({ title: `Before ${index}` })) } as const;
    await act(async () => { tree = create(card(preview)); });
    await layoutBand(128);
    await layoutRows(16);
    await act(async () => tree.update(card({ kind: 'workflow', steps: [{ title: 'After' }] })));
    await layoutRows(80);
    expect(rows()).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain('After');
    expect(JSON.stringify(tree.toJSON())).not.toContain('Before');
  });
});
