import { describe, expect, it } from 'vitest';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { compileWorkflowListFilterV1, WorkflowListFilterV1Schema } from './workflowListFilterV1.js';

describe('Workflow definition list filters', () => {
    it('narrows Hunts using the admitted repository-review fact and preserves unknown headers', () => {
        const hunts = compileWorkflowListFilterV1(WorkflowListFilterV1Schema.parse({ view: 'hunts' }));
        expect(hunts({ hunts: true })).toBe('match');
        expect(hunts({ hunts: false })).toBe('miss');
        expect(hunts({})).toBe('unavailable');
    });

    it('preserves unavailable source facts instead of broadening a saved Running or Triggered view', () => {
        const running = compileWorkflowListFilterV1({ view: 'running' });
        expect(running({ triggered: true })).toBe('unavailable');
        expect(running({ running: false })).toBe('miss');
        expect(running({ running: true })).toBe('match');
        const triggered = compileWorkflowListFilterV1({ view: 'triggered' });
        expect(triggered({ running: true })).toBe('unavailable');
        expect(triggered({ triggered: true })).toBe('match');
        expect(compileWorkflowListFilterV1({ view: 'all' })({})).toBe('match');
    });

    it('preserves future narrowing at stored ingress; it narrows no list', () => {
        const future = { view: 'all', futureField: { include: ['release'] }, extensions: { 'test.release/stage': { kind: 'future', value: 'ready' } } };
        expect(WorkflowListFilterV1Schema.safeParse(future).success).toBe(false);
        const read = createStoredReadSchema(WorkflowListFilterV1Schema).parse(future);
        expect(read).toEqual(future);
        expect(compileWorkflowListFilterV1(read)({ running: true, triggered: true })).toBe('match');
        expect(compileWorkflowListFilterV1({ ...read, view: 'running' })({ running: false })).toBe('miss');
    });
});
