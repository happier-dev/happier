import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { formatPermissionRequestDisplayHeadline, formatPermissionRequestDisplaySummary, resolveRequestToolLabel } from './permissionRequestDisplaySummary';

describe('pending request tool name', () => {
    it('names a Happier Action call by its translated title, never the raw tool id', () => {
        const request = { toolName: 'mcp__happier__action_spec_get', toolInput: { id: 'session.list' } };
        const title = t('actionPresentation.titles.action_spec_get');

        expect(resolveRequestToolLabel(request)).toBe(title);
        expect(formatPermissionRequestDisplaySummary(request)).toBe(t('tools.common.permissionSummary.required', { tool: title }));
        expect(formatPermissionRequestDisplaySummary({ ...request, toolInput: null }))
            .toBe(t('tools.common.permissionSummary.requiredWithoutDetails', { tool: title }));
    });

    it('names a third-party MCP tool readably and keeps native tool summaries in the viewer language', () => {
        expect(formatPermissionRequestDisplaySummary({ toolName: 'mcp__linear__search_issues', toolInput: { q: 'bug' } }))
            .not.toContain('mcp__');
        expect(resolveRequestToolLabel({ toolName: 'Bash', toolInput: { command: 'ls' } })).toBeNull();
        expect(formatPermissionRequestDisplaySummary({ toolName: 'Bash', toolInput: { command: 'ls' } }))
            .toBe(t('tools.common.permissionSummary.run', { command: 'ls' }));
    });

    it('titles a request by what it asks, its path read from the Session folder, and leaves generic asks to the tool title', () => {
        const metadata = { path: '/work/harbor-ledger' } as Parameters<typeof formatPermissionRequestDisplayHeadline>[0]['metadata'];
        expect(formatPermissionRequestDisplayHeadline({ toolName: 'Edit', metadata,
            toolInput: { file_path: '/work/harbor-ledger/src/billing/webhooks.ts' } }))
            .toBe(t('tools.common.permissionSummary.edit', { path: 'src/billing/webhooks.ts' }));
        expect(formatPermissionRequestDisplayHeadline({ toolName: 'WebFetch', metadata, toolInput: { url: 'https://docs.stripe.com' } }))
            .toBeNull();
    });
});
