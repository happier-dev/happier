import { describe, expect, it } from 'vitest';

import { validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { buildReviewStartWorkflowDraftSeed } from './reviewStartWorkflowDraft';

describe('prestart Review workflow authoring', () => {
    it('keeps an ordinary detached Review as an editable Action without inventing a Session or admitted round', () => {
        const seed = buildReviewStartWorkflowDraftSeed({
            input: { target: { kind: 'detached' }, cwd: '/chosen/project',
                reviewers: [{ kind: 'engine', engineId: 'claude', options: { nested: { retained: true } } }],
                then: 'report' },
            instructions: 'Inspect this project', sourceSession: null, name: 'Project Review',
            project: { machineId: 'chosen-machine', directory: '/chosen/project' }, executionTarget: 'detached_run',
        });
        expect(seed).toMatchObject({ project: { machineId: 'chosen-machine', directory: '/chosen/project' }, executionTarget: 'detached_run' });
        if (!seed.draft) throw new Error('Expected the ordinary editable draft');
        const validation = validateWorkflowEditorDraft(seed.draft);
        expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
        const block = validation.normalizedDefinition?.blocks[0];
        if (block?.kind !== 'action') throw new Error('Expected a Review Action');
        expect(block).toMatchObject({ actionId: 'review.start', input: {
            target: { kind: 'literal', value: { kind: 'detached' } },
            cwd: { kind: 'literal', value: '/chosen/project' },
            instructions: { kind: 'literal', value: 'Inspect this project' },
            reviewers: { kind: 'literal', value: [{ kind: 'engine', engineId: 'claude', options: { nested: { retained: true } } }] },
        } });
        expect(block.input).not.toHaveProperty('sessionId');
        expect(block.input).not.toHaveProperty('sourceSession');
        expect(block.input).not.toHaveProperty('reviewRound');
    });
});
