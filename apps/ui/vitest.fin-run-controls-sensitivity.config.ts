import base from './vitest.config';

// Sensitivity mutation only: restore the prior admission closure in memory.
// Shared source stays fixed while the real screen, Actions and push path run.
export default {
    ...base,
    plugins: [...(base.plugins ?? []), {
        name: 'fin-run-controls-prior-admission-sensitivity',
        enforce: 'pre',
        transform(source: string, id: string) {
            if (!id.split('?')[0]?.endsWith('/components/workflows/screens/WorkflowRunScreen.tsx')) return null;
            const changes = [
                ['if (!canEdit || runId === null) return;', 'if (!canEdit || runId === null || summary === null) return;'],
                ['        const current = getStorage().getState().workflowRunsById[workflowRunStoreKey(runId, lifetime.scope)]?.summary;\n        if (current == null) return;\n', ''],
                ['await operation(current, owns, {', 'await operation(summary, owns, {'],
                ['[accountLifetime, canEdit, contentIdentity, isContentIdentityCurrent, runId]);', '[accountLifetime, canEdit, contentIdentity, isContentIdentityCurrent, runId, summary]);'],
            ];
            let code = source;
            for (const [fixed, previous] of changes) {
                if (!code.includes(fixed!)) throw new Error('Admission sensitivity mutation no longer matches current source');
                code = code.replace(fixed!, previous!);
            }
            code = code.replace('            const result = await operation(summary, owns, {', `
            if (kind === 'retry') {
                const canonical = getStorage().getState().workflowRunsById[workflowRunStoreKey(runId, lifetime.scope)]?.summary;
                console.info('FIN_RUN_CONTROL_CANONICAL_PROJECTION', {
                    present: canonical != null, revision: canonical?.revision,
                    renderedRevision: summary?.revision, renderedIsCanonical: canonical === summary,
                    lifetimeCurrent: lifetime.isCurrent(),
                });
            }
            const result = await operation(summary, owns, {`);
            return { code, map: null };
        },
    }],
};
