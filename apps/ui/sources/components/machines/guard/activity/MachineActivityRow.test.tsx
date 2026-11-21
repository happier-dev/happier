import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { MachineGuardActivityRowV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

import { MachineActivityRow } from './MachineActivityRow';

function startFailure(overrides: Record<string, unknown>) {
    return MachineGuardActivityRowV1Schema.parse({
        v: 1, id: 'failed-resume', at: 1, kind: 'start_failed', rule: 'idle_sessions',
        subject: { kind: 'session', sessionId: 'session', title: 'Build' },
        outcome: 'failed', attribution: { kind: 'unknown' },
        failure: { reason: 'no_ptys' }, nextStep: 'close_idle_terminals',
        note: 'Could not resume: spawn-rejected',
        ...overrides,
    });
}

describe('MachineActivityRow start failure', () => {
    it('tells why and what to try in plain words, never the raw reason or the daemon note', async () => {
        const screen = await renderScreen(<MachineActivityRow machineName="Lima" entry={startFailure({})} />);
        const text = screen.getTextContent();
        expect(text).toContain(t('machineGuard.activity.startFailure.no_ptys'));
        expect(text).toContain(t('machineGuard.activity.nextStep.close_idle_terminals'));
        expect(text).not.toMatch(/no_ptys|spawn-rejected|machineGuard\./);
    });

    it('reads the other failure, and an undone receipt only says when it was undone', async () => {
        const plain = await renderScreen(<MachineActivityRow machineName="Lima" entry={startFailure({ failure: { reason: 'other' }, nextStep: 'review_processes' })} />);
        expect(plain.getTextContent()).toContain(t('machineGuard.activity.startFailure.other'));
        expect(plain.getTextContent()).toContain(t('machineGuard.activity.nextStep.review_processes'));
        const undone = await renderScreen(<MachineActivityRow machineName="Lima" entry={startFailure({ undoneAt: 2 })} />);
        expect(undone.getTextContent()).not.toContain(t('machineGuard.activity.startFailure.no_ptys'));
    });
});
