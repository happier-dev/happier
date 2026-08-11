import { describe, expect, it } from 'vitest';

import { readBashBackgroundTaskId } from './backgroundTask';

describe('readBashBackgroundTaskId', () => {
    it('reads the id from the JSON-encoded transcript envelope', () => {
        const result = JSON.stringify({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task_1' });
        expect(readBashBackgroundTaskId(result)).toBe('task_1');
    });

    it('reads the id from the nested tool_use_result envelope written by the SDK log converter', () => {
        const result = { content: 'Command running in background', tool_use_result: { backgroundTaskId: 'task_2' } };
        expect(readBashBackgroundTaskId(result)).toBe('task_2');
    });

    it('accepts the snake_case spelling the sidechain collector already tolerates', () => {
        expect(readBashBackgroundTaskId({ background_task_id: 'task_3' })).toBe('task_3');
    });

    it('does not invent a task id from a run_in_background request the provider may have declined', () => {
        // `run_in_background` lives on the tool INPUT and is a request; only the result attests.
        expect(readBashBackgroundTaskId({ stdout: 'done', run_in_background: true })).toBeNull();
    });

    it('ignores blank and non-string ids', () => {
        expect(readBashBackgroundTaskId({ backgroundTaskId: '   ' })).toBeNull();
        expect(readBashBackgroundTaskId({ backgroundTaskId: 7 })).toBeNull();
        expect(readBashBackgroundTaskId('plain stdout text')).toBeNull();
        expect(readBashBackgroundTaskId(null)).toBeNull();
    });
});
