import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ArtifactCardPreview } from './ArtifactCardPreview';

describe('ArtifactCardPreview', () => {
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
