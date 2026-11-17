import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import { PET_ANIMATION_STATES_V1 } from '@happier-dev/protocol/pets/constants';
import { readHatchPetProgressPresentation } from './transcriptHatchPetProgress';

function snapshot(petName: string, drawn: number) {
    return { kind: 'hatch_pet_progress_v1', petName,
        steps: { gettingReady: { status: 'completed' }, mainLook: { status: 'completed' }, poses: { status: drawn === 9 ? 'completed' : 'in_progress' }, hatching: { status: 'pending' } },
        poses: Object.fromEntries(PET_ANIMATION_STATES_V1.map((state, index) => [state, { status: index < drawn ? 'drawn' : index === drawn ? 'drawing' : 'pending' }])) };
}
function bash(id: string, stdout: string): ToolCall {
    return { name: 'Bash', state: 'completed', input: { command: 'python3 hatch.py' }, result: { stdout, stderr: '', exit_code: 0 },
        createdAt: 0, startedAt: 0, completedAt: 0, description: null, id } as unknown as ToolCall;
}
function message(tool: ToolCall): Message {
    return { kind: 'tool-call', id: tool.id as unknown as string, localId: null, createdAt: 0, tool, children: [] } as unknown as Message;
}

describe('readHatchPetProgressPresentation', () => {
    it('draws Hatch pet\'s checklist from a phase command\'s final progress line, and only its latest snapshot', () => {
        const first = bash('a', `drawing\n${JSON.stringify(snapshot('Capy', 2))}`);
        const second = bash('b', JSON.stringify(snapshot('Capy', 5)));
        const messages = [message(first), message(second)];
        const older = readHatchPetProgressPresentation({ tool: first, messages });
        const latest = readHatchPetProgressPresentation({ tool: second, messages });
        expect(older?.visible).toBe(false);
        expect(latest).toMatchObject({ visible: true, plan: { petName: 'Capy', drawnPoseCount: 5, totalPoseCount: 9 } });
    });

    it('leaves an ordinary command to the Bash view', () => {
        const tool = bash('c', 'hello');
        expect(readHatchPetProgressPresentation({ tool, messages: [message(tool)] })).toBeNull();
    });
});
