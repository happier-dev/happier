import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ArtifactCardPreview } from './ArtifactCardPreview';
import type { ArtifactPreview } from './artifactBrowserModel';
import { getWidgetSizeFootprintV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';

function boardWidgetPreview(title: string, size: WidgetSizeV1, position?: { x: number; y: number }) {
    const footprint = getWidgetSizeFootprintV1('workBoard', size);
    if (!footprint) throw new Error('WorkBoard preview requires a supported footprint');
    return { title, size, footprint: { columns: footprint.columns, columnSpan: footprint.columnSpan, rowSpan: footprint.rowSpan },
        ...(position ? { position } : {}) };
}

async function measurePreview(screen: Awaited<ReturnType<typeof renderScreen>>, summaryHeight?: number) {
    const band = screen.tree.findByTestId('preview');
    if (!band?.props.onLayout) return;
    await act(async () => band.props.onLayout({ nativeEvent: { layout: { height: 128, width: 260, x: 0, y: 0 } } }));
    if (summaryHeight !== undefined) {
        const summary = band.findAll(node => typeof node.type === 'string' && node.props.style?.gap === 6
            && node.props.style?.flexDirection === undefined)[0];
        await act(async () => summary?.props.onLayout({ nativeEvent: { layout: { height: summaryHeight, width: 228, x: 16, y: 14 } } }));
    }
    const rows = () => band.findAll(node => typeof node.type === 'string' && node.props.style?.flexDirection === 'row');
    let measured = 0;
    while (measured < rows().length) {
        const row = rows()[measured]!;
        await act(async () => row.props.onLayout({ nativeEvent: { layout: { height: 16, width: 228, x: 16, y: 14 + measured * 22 } } }));
        measured += 1;
    }
}

describe('ArtifactCardPreview', () => {
    it('reuses unchanged palette, translated labels and host bindings when a saved preview is reprojected', async () => {
        const preview: Extract<ArtifactPreview, { kind: 'board' }> = { kind: 'board', layout: { mode: 'canvas',
            source: { sections: ['needs_you'], hasFilter: false, pickedCount: 0 },
            widgets: [boardWidgetPreview('Notes', 'full')],
        } };
        const screen = await renderScreen(<ArtifactCardPreview kind="board" preview={preview} />);
        try {
            const first = screen.tree.root.find(node => node.props.preview === preview && node.props.host).props;
            const nextPreview = { ...preview, layout: { ...preview.layout } };
            await screen.update(<ArtifactCardPreview kind="board" preview={nextPreview} />);
            const next = screen.tree.root.find(node => node.props.preview === nextPreview && node.props.host).props;
            expect(next.colors).toBe(first.colors);
            expect(next.boardLabels).toBe(first.boardLabels);
            expect(next.host).toBe(first.host);
            await screen.update(<ArtifactCardPreview kind="board" preview={{ ...preview, layout: {
                ...preview.layout, widgets: [...preview.layout.widgets, boardWidgetPreview('Links', 'medium')],
            } }} />);
            expect(JSON.stringify(screen.tree.toJSON())).toContain('2 widgets');
        } finally { await screen.unmount(); }
    });
    it('shows the saved Board source names, widget count and layout without widget execution', async () => {
        const screen = await renderScreen(<ArtifactCardPreview testID="preview" kind="board" preview={{ kind: 'board', layout: {
            mode: 'canvas', source: { sections: ['needs_you', 'my_machines'], hasFilter: true, pickedCount: 7 },
            widgets: [boardWidgetPreview('Notes', 'full', { x: 24, y: 48 }), boardWidgetPreview('Links', 'medium')],
        } }} />);
        try {
            await measurePreview(screen, 36);
            const rendered = JSON.stringify(screen.tree.toJSON());
            for (const label of ['Canvas', 'Needs you', 'My machines', 'Sessions', '2 widgets', 'Notes', 'Links', '(24, 48)']) expect(rendered).toContain(label);
            expect(rendered.indexOf('Notes')).toBeLessThan(rendered.indexOf('Links'));
        } finally { await screen.unmount(); }
    });
    it('shows saved Workflow step labels in their authored order rather than only a generic kind mark', async () => {
        const screen = await renderScreen(<ArtifactCardPreview testID="preview" kind="workflow"
            preview={{ kind: 'workflow', steps: [{ title: 'Read new issues' }, { title: 'Ask before posting' }] }} />);
        try {
            await measurePreview(screen);
            const rendered = JSON.stringify(screen.tree.toJSON());
            expect(rendered).toContain('Read new issues');
            expect(rendered).toContain('Ask before posting');
            expect(rendered.indexOf('Read new issues')).toBeLessThan(rendered.indexOf('Ask before posting'));
        } finally { await screen.unmount(); }
    });
});
