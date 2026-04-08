import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput, captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const promptAnswers: string[] = [];
const promptQuestions: string[] = [];

const {
    buildDoctorSnapshotMock,
    buildHappierRuntimeRepairPlanMock,
    applyHappierRuntimeRepairPlanMock,
} = vi.hoisted(() => ({
    buildDoctorSnapshotMock: vi.fn(async () => ({
        capturedAt: '2026-02-23T00:00:00.000Z',
        server: {
            activeServerId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            publicServerUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
        },
        settings: {
            activeServerId: 'cloud',
            servers: [],
            knownAccountIds: [],
        },
    })),
    buildHappierRuntimeRepairPlanMock: vi.fn(() => ({
        actions: [{
            kind: 'install-default-following-service',
            command: 'happier service install --yes',
            mode: 'user',
            targetServerUrl: 'https://api.happier.dev',
        }],
        manualWarnings: [],
    })),
    applyHappierRuntimeRepairPlanMock: vi.fn(async () => ({
        executedActions: [{ kind: 'install-default-following-service' }],
    })),
}));

vi.mock('node:readline', () => ({
    createInterface: () => ({
        question: (prompt: string, cb: (answer: string) => void) => {
            promptQuestions.push(prompt);
            cb(promptAnswers.shift() ?? '');
        },
        close: () => {},
    }),
}));

vi.mock('@/ui/doctorSnapshot', () => ({
    buildDoctorSnapshot: () => buildDoctorSnapshotMock(),
}));

vi.mock('@/diagnostics/happierRuntimeRepair', () => ({
    buildHappierRuntimeRepairPlan: buildHappierRuntimeRepairPlanMock,
    applyHappierRuntimeRepairPlan: applyHappierRuntimeRepairPlanMock,
}));

import { handleServiceRepairCliCommand } from './handleServiceRepairCliCommand';

describe('happier service repair', () => {
    afterEach(() => {
        buildDoctorSnapshotMock.mockClear();
        buildHappierRuntimeRepairPlanMock.mockClear();
        applyHappierRuntimeRepairPlanMock.mockClear();
        promptAnswers.length = 0;
        promptQuestions.length = 0;
    });

    it('prints a dry-run JSON repair plan by default', async () => {
        const output = captureConsoleJsonOutput<{ ok: boolean; executed: boolean; actions: Array<{ kind: string }> }>();
        try {
            await handleServiceRepairCliCommand({
                argv: ['repair', '--json'],
                commandPath: 'happier service',
            });

            expect(buildDoctorSnapshotMock).toHaveBeenCalled();
            expect(buildHappierRuntimeRepairPlanMock).toHaveBeenCalled();
            expect(applyHappierRuntimeRepairPlanMock).not.toHaveBeenCalled();
            expect(output.json()).toEqual(expect.objectContaining({
                ok: true,
                executed: false,
                actions: [expect.objectContaining({ kind: 'install-default-following-service' })],
            }));
        } finally {
            output.restore();
        }
    });

    it('executes the repair plan when --yes is provided', async () => {
        const output = captureConsoleJsonOutput<{ ok: boolean; executed: boolean; executedActions: Array<{ kind: string }> }>();
        try {
            await handleServiceRepairCliCommand({
                argv: ['repair', '--yes', '--json'],
                commandPath: 'happier service',
            });

            expect(applyHappierRuntimeRepairPlanMock).toHaveBeenCalled();
            expect(output.json()).toEqual(expect.objectContaining({
                ok: true,
                executed: true,
                executedActions: [expect.objectContaining({ kind: 'install-default-following-service' })],
            }));
        } finally {
            output.restore();
        }
    });

    it('prompts interactively to apply the recommended repair plan in text mode', async () => {
        const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        const output = captureConsoleLogAndMuteStdout();
        promptAnswers.push('y');

        try {
            await handleServiceRepairCliCommand({
                argv: ['repair'],
                commandPath: 'happier service',
            });

            expect(promptQuestions).toEqual([
                'Apply these recommended background-service repair actions now? [Y/n]: ',
            ]);
            expect(applyHappierRuntimeRepairPlanMock).toHaveBeenCalled();
            expect(output.logs.join('\n')).toContain('Applied 1 background-service repair action(s).');
        } finally {
            output.restore();
            promptAnswers.length = 0;
            promptQuestions.length = 0;
            if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
            else delete (process.stdin as { isTTY?: boolean }).isTTY;
            if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
            else delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
    });

    it('fails closed on unrecognized interactive repair answers', async () => {
        const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        const output = captureConsoleLogAndMuteStdout();
        promptAnswers.push('maybe');

        try {
            await handleServiceRepairCliCommand({
                argv: ['repair'],
                commandPath: 'happier service',
            });

            expect(applyHappierRuntimeRepairPlanMock).not.toHaveBeenCalled();
            expect(output.logs.join('\n')).not.toContain('Applied 1 background-service repair action(s).');
        } finally {
            output.restore();
            promptAnswers.length = 0;
            promptQuestions.length = 0;
            if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
            else delete (process.stdin as { isTTY?: boolean }).isTTY;
            if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
            else delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
    });
});
