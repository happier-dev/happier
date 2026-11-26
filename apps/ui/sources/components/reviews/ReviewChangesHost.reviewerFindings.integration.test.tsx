import * as React from 'react';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { act } from 'react-test-renderer';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ReviewCommentPublicationPlanV1Schema, buildReviewCommentPublicationEntryV1,
    preflightReviewCommentPublicationRoutingV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { ReviewCommentCreateRequestV1Schema, type ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createReviewRunCommentService } from '../../../../cli/src/agent/executionRuns/profiles/review/reviewComments';
import { createCliReviewCommentActionExecutorFromCredentials } from '../../../../cli/src/agent/reviews/comments/executor';
import { normalizeParsedReviewContent } from '../../../../cli/src/agent/reviews/normalize/normalizeStrictJsonReviewOutput';
import type { ExecutionRunState } from '../../../../cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { readSliceFinding } from '../../../../../packages/plugins/review-slices/src/agent/reviews/state';
import { normalizeRoborevReview } from '../../../../../packages/plugins/review-panels/src/agent/reviews/document';
import { normalizeDeepSecFindings } from '../../../../../packages/plugins/review-deepsec/src/agent/reviews/findings';
import { parseDeepSecCommentOutMarkdown } from '../../../../../packages/plugins/review-deepsec/src/agent/reviews/commentOut';
import { createCodeRabbitAgentOutput } from '../../../../../packages/plugins/review-coderabbit/src/agent/reviews/agentOutput';
import { createLocalScmRepositoryFixture, runScmExecutable } from '../../../../cli/src/testkit/scm/scmBackendContractFixtures';

// The daemon-to-Home HTTP boundary is substituted; normalization, signing,
// materialization, captured evidence and the mounted Changes reader remain real.
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return { ...actual, default: { ...actual.default, post: vi.fn(), get: vi.fn(), patch: vi.fn() } };
});
installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
const repositories: string[] = [];
afterEach(async () => {
    standardCleanup(); await fixture?.dispose(); vi.clearAllMocks();
    await Promise.all(repositories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

type Reviewer = 'claude' | 'codex' | 'clawpatch' | 'roborev' | 'deepsec' | 'coderabbit' | 'hunt';
const finding = { id: 'finding', title: 'Total subtracts prices', summary: 'Addition is required.',
    severity: 'high', category: 'correctness', filePath: 'total.ts', startLine: 2 } satisfies ReviewFinding;

function reviewerFindings(reviewer: Reviewer, startLine = 2, fileOnly = false): readonly ReviewFinding[] {
    if (reviewer === 'clawpatch') return [readSliceFinding({ schemaVersion: 1, findingId: 'native', featureId: 'totals',
        category: 'bug', severity: 'high', confidence: 'high', title: finding.title, reasoning: finding.summary,
        evidence: [{ path: 'total.ts', ...(fileOnly ? { startLine: null, endLine: null } : { startLine, endLine: startLine }) }], recommendation: 'Add each price.' }, 'native', 'run', 0).finding];
    if (reviewer === 'roborev') return normalizeRoborevReview({ structured_output: { schema_version: 3,
        summary: 'Reviewed', verdict: 'fail', findings: [{ problem: finding.title, severity: 'high', fix: 'Add each price.',
            file: 'total.ts', start_line: startLine, end_line: startLine }] } }).findings;
    if (reviewer === 'deepsec') return normalizeDeepSecFindings(parseDeepSecCommentOutMarkdown(
        `### total.ts:${startLine}\n**Severity:** high\n\n${finding.summary}\n`));
    if (reviewer === 'coderabbit') {
        const output = createCodeRabbitAgentOutput();
        output.write(new TextEncoder().encode([
            JSON.stringify({ type: 'finding', title: finding.title, comment: finding.summary, severity: 'major', fileName: 'total.ts', startLine, endLine: startLine }),
            JSON.stringify({ type: 'complete', status: 'review_completed', findings: 1 }), '',
        ].join('\n')));
        const content = normalizeParsedReviewContent({ value: JSON.parse(output.finish(0).output), generatedAtMs: 1 });
        if (!content) throw new Error('CodeRabbit fixture did not normalize');
        return content.findings;
    }
    const content = normalizeParsedReviewContent({ value: { summary: 'Reviewed', reviewOutcome: 'complete',
        findings: [{ ...finding, startLine: fileOnly ? undefined : startLine }] }, generatedAtMs: 1 });
    if (!content) throw new Error('Agent fixture did not normalize');
    return content.findings;
}

it.each([
    ...(['claude', 'codex', 'clawpatch', 'roborev', 'deepsec', 'coderabbit', 'hunt'] as const)
        .map(reviewer => ({ reviewer, scope: 'comparison' as const, fileOnly: false })),
    ...(['clawpatch', 'hunt'] as const).flatMap(reviewer => [false, true]
        .map(fileOnly => ({ reviewer, scope: 'repository' as const, fileOnly }))),
])('materializes $reviewer $scope findings into Changes (file-only: $fileOnly)', async ({ reviewer, scope, fileOnly }) => {
        const repository = scope === 'repository'
            ? createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-review-inline-' }) : null;
        const cwd = repository?.rootPath ?? '/repo';
        const startLine = repository ? 12 : 2;
        if (repository) {
            repositories.push(cwd);
            await writeFile(join(cwd, 'total.ts'), `${'// Existing context\n'.repeat(10)}export function total(prices: number[]) {\n  return prices.reduce((sum, price) => sum - price, 0);\n}\n`);
            runScmExecutable(cwd, 'git', ['add', 'total.ts']);
            runScmExecutable(cwd, 'git', ['commit', '-m', 'Existing repository total']);
            expect(runScmExecutable(cwd, 'git', ['status', '--porcelain'])).toBe('');
        }
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: { kind: 'pullRequest', locator: {
            providerId: 'github', repository: 'qa/review', number: 1 } }, repository: { rootPath: '/repo' },
            endpoints: { before: 'b'.repeat(40), after: 'c'.repeat(40) },
            inventory: { state: 'complete', reasons: [], files: [{ path: 'total.ts', changeKind: 'modified', binary: false,
                generated: false, lockfile: false, occurrences: [{ id: 'total-change', alias: 'total-change', path: 'total.ts', position: 0,
                    before: { startLine: 2, lineCount: 1 }, after: { startLine: 2, lineCount: 1 } }], evidence: { state: 'available', unifiedDiff:
                    '@@ -1,3 +1,3 @@\n export function total(prices: number[]) {\n-  return prices.reduce((sum, price) => sum + price, 0);\n+  return prices.reduce((sum, price) => sum - price, 0);\n }\n' } }] } });
        const saved: ReviewCommentV1[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            const request = ReviewCommentCreateRequestV1Schema.parse(body);
            const comment = buildReviewCommentFixture({ ...request, id: `saved-${reviewer}`,
                author: { kind: 'agent', agentId: reviewer === 'hunt' ? 'codex' : reviewer, sessionId: 's1' } });
            saved.push(comment);
            return { status: 200, data: { comment, replayed: false } };
        });
        const signingKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token: 'fixture', encryption: null },
                resolveAccountId: () => 'alice', resolveAccountEncryptionMode: async () => 'plain',
                resolvePrincipalSigningContext: async () => ({ machineId: 'm1', installationId: 'installation',
                    privateKeyBase64Url: Buffer.from(signingKeys.secretKey).toString('base64url') }) });
        let transportFailure: unknown;
        const service = createReviewRunCommentService({ cwd, scope: { workspace: { machineId: 'm1', path: cwd } },
            execute: async (...args) => { try { return await execute(...args); } catch (error) { transportFailure = error; throw error; } } });
        const run = { runId: 'run', callId: 'call', sidechainId: 'sidechain', sessionId: 's1', depth: 0,
            intent: 'review', backendId: reviewer, backendTarget: { kind: 'builtInAgent', agentId: reviewer },
            instructions: 'Review', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
            ioMode: 'request_response', status: 'running', startedAtMs: 1, intentInput: { reviewReviewerId: reviewer,
                ...(scope === 'repository' ? { scope } : {}) },
        } satisfies ExecutionRunState;
        const producer = reviewer === 'hunt' ? { session: { sessionId: 's1', localInputId: 'input', workflowRunId: 'workflow',
            stepId: 'review', invocationId: 'invocation', agentId: 'codex', reviewerId: reviewer } } : { run };
        const result = await service.materialize({ ...producer, findings: reviewerFindings(reviewer, startLine, fileOnly), reviewedFingerprint: null,
            ...(scope === 'comparison' ? { comparison } : {}) });
        expect(transportFailure).toBeUndefined();
        expect(result).toMatchObject({ status: 'materialized', failures: [] });
        expect(saved).toHaveLength(1);
        expect(saved[0]?.anchor).toEqual(fileOnly ? { kind: 'file', filePath: 'total.ts' }
            : { kind: 'line', filePath: 'total.ts', line: startLine, ...(scope === 'comparison' ? { side: 'after' } : {}) });
        expect(saved[0]).toMatchObject({
            snapshot: { kind: 'text', source: scope === 'comparison' ? 'diffSide' : 'workingTree',
                selectedLines: [fileOnly ? '// Existing context' : '  return prices.reduce((sum, price) => sum - price, 0);'] } });
        if (repository) await writeFile(join(cwd, 'total.ts'), 'CURRENT FILE MUST NOT REPLACE THE SAVED EVIDENCE\n');
        if (scope === 'comparison') {
        const plan = ReviewCommentPublicationPlanV1Schema.parse({ target: { providerId: 'github', configuredAccountId: 'forge',
            entryRef: { sourceId: 'github', kindId: 'pull-request', collisionScope: 'qa/review', entryId: '1' }, subtarget: null },
            baseRevision: comparison.endpoints.before, headRevision: comparison.endpoints.after,
            entries: saved.map(buildReviewCommentPublicationEntryV1), verdict: null });
        expect(preflightReviewCommentPublicationRoutingV1(plan)).toMatchObject({ kind: 'ready', inlineEntryIndexes: [0], verdictSummaryEntryIndexes: [] });
        }

        fixture = await createSessionFilesViewFixture({ rootPath: cwd, rpc: request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE
            ? { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } } : undefined });
        const { ReviewChangesHost } = await import('./ReviewChangesHost');
        const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
        const onOpenComment = vi.fn();
        const screen = await fixture.render(<ReviewChangesHost reviewId="review" roundOrdinal={1} scope={{ serverId: fixture.scope.serverId, accountId: 'alice' }}
            capture={scope === 'comparison' ? { target: { kind: 'machine', machineId: 'm1' }, input: { cwd, comparisonId: comparison.id, source: comparison.source } } : null}
            comments={saved} view="files" onSelectView={() => {}} onOpenComment={onOpenComment} />);
        if (scope === 'comparison') {
            await vi.waitFor(() => expect(screen.findAllByType(WorkspaceScmReviewBody)).toHaveLength(1));
            await act(async () => screen.findByType(WorkspaceScmReviewBody).findAll(node => typeof node.props.onLayout === 'function')[0]
                ?.props.onLayout({ nativeEvent: { layout: { width: 900, height: 360 } } }));
        } else {
            expect(screen.getTextContent()).toContain(fileOnly ? '// Existing context' : 'sum - price');
            expect(screen.getTextContent()).not.toContain('CURRENT FILE');
            expect(fixture.requests).toEqual([]);
        }
        await vi.waitFor(() => expect(screen.findByTestId(`review-finding-anchor:saved-${reviewer}`)).not.toBeNull());
        await screen.pressByTestIdAsync(`review-finding-anchor:saved-${reviewer}`);
        expect(onOpenComment).toHaveBeenCalledWith(`saved-${reviewer}`);
        await screen.unmount();
    });
