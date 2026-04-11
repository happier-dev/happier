import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SourceControlOperationsHistoryTimelineRow } from './SourceControlOperationsHistoryTimelineRow';

describe('SourceControlOperationsHistoryTimelineRow', () => {
    const theme = {
        colors: {
            text: '#fff',
            textSecondary: '#aaa',
            textLink: '#09f',
            divider: '#333',
            surface: '#111',
            surfaceHigh: '#222',
            input: { background: '#111' },
        },
    } as any;

    it('exposes a readable accessibility label on the commit row', async () => {
        const timestamp = new Date('2026-04-10T11:59:00.000Z').getTime();
        const screen = await renderScreen(
            <SourceControlOperationsHistoryTimelineRow
                theme={theme}
                entry={{
                    sha: 'abc123',
                    shortSha: 'abc123',
                    authorName: 'Leeroy',
                    authorEmail: 'leeroy@example.com',
                    timestamp,
                    subject: 'Fix mobile cockpit history',
                    body: '',
                }}
                isHead={true}
                showTrailingLine={false}
                onOpenCommit={() => {}}
            />,
        );

        const row = screen.root.findByProps({ testID: 'scm-commit-entry-abc123' });
        expect(row.props.accessibilityLabel).toContain('Fix mobile cockpit history');
        expect(row.props.accessibilityLabel).toContain('Leeroy');
        expect(String(row.props.accessibilityLabel)).not.toContain('1m');
    });
});
