import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('protocol package root exports', () => {
    it('exports scm commit limits and operation codes for CLI consumers', () => {
        expect(protocol.SCM_COMMIT_MESSAGE_MAX_LENGTH).toBe(4096);
        expect(protocol.SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY).toBe('NOT_REPOSITORY');
        expect(typeof protocol.evaluateScmRemoteMutationPolicy).toBe('function');
        expect(typeof protocol.inferScmRemoteTarget).toBe('function');
        expect(typeof protocol.mapGitScmErrorCode).toBe('function');
        expect(typeof protocol.mapSaplingScmErrorCode).toBe('function');
        expect(typeof protocol.normalizeScmRemoteRequest).toBe('function');
    });

    it('exports automation change/update schemas through root exports', () => {
        expect(protocol.ChangeKindSchema.parse('automation')).toBe('automation');
        const parsed = protocol.UpdateBodySchema.parse({
            t: 'automation-upsert',
            automationId: 'auto_1',
            version: 1,
            enabled: true,
            updatedAt: Date.now(),
        });
        expect(parsed.t).toBe('automation-upsert');
    });

    it('exports voice mediator streaming schemas', () => {
        expect(typeof protocol.VoiceMediatorTurnStreamStartRequestSchema).toBe('object');
        expect(typeof protocol.VoiceMediatorTurnStreamReadResponseSchema).toBe('object');
        expect(typeof protocol.VoiceMediatorTurnStreamCancelRequestSchema).toBe('object');
    });

    it('exports bug report routing defaults', () => {
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_OWNER).toBe('happier-dev');
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_REPO).toBe('happier');
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_LABELS).toEqual(['bug']);
        expect(typeof protocol.normalizeBugReportProviderUrl).toBe('function');
        expect(typeof protocol.normalizeBugReportIssueSlug).toBe('function');
        expect(typeof protocol.resolveBugReportServerDiagnosticsLines).toBe('function');
        expect(typeof protocol.searchBugReportSimilarIssues).toBe('function');

        const url = protocol.buildBugReportFallbackIssueUrl({
            title: 'Example',
            body: 'Body',
            owner: '',
            repo: '',
        });
        expect(url).toContain('https://github.com/happier-dev/happier/issues/new?');
    });
});
