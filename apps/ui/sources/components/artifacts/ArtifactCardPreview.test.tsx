import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ArtifactCardPreview } from './ArtifactCardPreview';

describe('ArtifactCardPreview', () => {
    it('shows the saved Board source names, widget count and layout without widget execution', async () => {
        const screen = await renderScreen(<ArtifactCardPreview kind="board" preview={{ kind: 'board', layout: {
            mode: 'canvas', source: { sections: ['needs_you', 'my_machines'], hasFilter: true, pickedCount: 7 },
            widgets: [{ title: 'Notes', width: 2, position: { x: 24, y: 48 } }, { title: 'Links', width: 1 }],
        } }} />);
        try {
            const rendered = JSON.stringify(screen.tree.toJSON());
            for (const label of ['Canvas', 'Needs you', 'My machines', 'Sessions', '2 widgets', 'Notes', 'Links', '(24, 48)']) expect(rendered).toContain(label);
            expect(rendered.indexOf('Notes')).toBeLessThan(rendered.indexOf('Links'));
        } finally { await screen.unmount(); }
    });
    it('shows saved Workflow step labels in their authored order rather than only a generic kind mark', async () => {
        const screen = await renderScreen(<ArtifactCardPreview kind="workflow"
            preview={{ kind: 'workflow', steps: [{ title: 'Read new issues' }, { title: 'Ask before posting' }] }} />);
        try {
            const rendered = JSON.stringify(screen.tree.toJSON());
            expect(rendered).toContain('Read new issues');
            expect(rendered).toContain('Ask before posting');
            expect(rendered.indexOf('Read new issues')).toBeLessThan(rendered.indexOf('Ask before posting'));
        } finally { await screen.unmount(); }
    });
});
