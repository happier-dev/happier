import { describe, expect, it } from 'vitest';
import type { MachineResourceAttentionV1, MachineResourceReasonV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import {
    describeFleetDescription,
    describeFleetTitle,
    describeMachineAttentionFigure,
    describeMachineAttentionWord,
    describeMachineReasonPhrase,
    describeMachineSentence,
    describeMachinesRailTooltip,
    resolveMachineReasonAction,
    selectAttentionSubjects,
} from './machineResourceSentences';
import { machineResourceAlertTab } from '@/components/machines/page/machinePageHref';

const NOW = 10_000_000;
const memory: MachineResourceReasonV1 = { key: 'memory', level: 'needs_you', since: NOW - 6 * 60_000, metric: 'memory',
    nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: true };
const disk: MachineResourceReasonV1 = { key: 'disk', level: 'look', since: NOW - 60 * 60_000, metric: 'disk',
    nextStep: 'free_up_space', kind: 'disk_nearly_full', volumeId: 'v', volumeLabel: '/data' };
const calm: MachineResourceAttentionV1 = { level: 'calm', reasons: [] };

describe('machine sentences (MPG-28)', () => {
    const fleet = [
        { name: 'nl2', attention: { level: 'look' as const, reasons: [disk] } },
        { name: 'edge-1', attention: { level: 'needs_you' as const, reasons: [memory] } },
        { name: 'win-dev', attention: calm },
    ];

    it('lists the machine that needs you before the one worth a look', () => {
        expect(selectAttentionSubjects(fleet).map(subject => subject.name)).toEqual(['edge-1', 'nl2']);
    });

    it('titles the fleet by how many need a look, one machine by its reason, and a calm fleet as calm', () => {
        expect(describeFleetTitle({ subjects: fleet, reportingCount: 3 })).toBe('2 machines need a look');
        expect(describeFleetTitle({ subjects: [fleet[1]!], reportingCount: 1 })).toBe('edge-1 is short on memory');
        expect(describeFleetTitle({ subjects: [fleet[2]!], reportingCount: 1 })).toBe('All calm');
        expect(describeFleetTitle({ subjects: [fleet[2]!, fleet[2]!], reportingCount: 2 })).toBe('All calm');
        // Nothing reports resources yet: the surface keeps its plain title.
        expect(describeFleetTitle({ subjects: [], reportingCount: 0 })).toBeNull();
    });

    it('never repeats the title or the Needs-you list: the sentence says only how the others online are', () => {
        // The Needs-you rows beneath name each machine and its reason; the sentence does not name them again.
        expect(describeFleetDescription({ subjects: fleet, reportingCount: 3, onlineCount: 6, nowMs: NOW }))
            .toBe('The other 4 online are calm.');
        const one = [fleet[1]!];
        expect(describeFleetTitle({ subjects: one, reportingCount: 3 })).toBe('edge-1 is short on memory');
        expect(describeFleetDescription({ subjects: one, reportingCount: 3, onlineCount: 6, nowMs: NOW }))
            .toBe('The other 5 online are calm.');
        // With nothing else to say the page keeps its own line.
        expect(describeFleetDescription({ subjects: one, reportingCount: 1, onlineCount: 1, nowMs: NOW })).toBeNull();
        const four = ['a', 'b', 'c', 'd'].map(name => ({ name, attention: { level: 'needs_you' as const, reasons: [memory] } }));
        expect(describeFleetDescription({ subjects: four, reportingCount: 4, onlineCount: 11, nowMs: NOW }))
            .toBe('The other 7 online are calm.');
        expect(describeFleetDescription({ subjects: four.slice(0, 2), reportingCount: 2, onlineCount: 2, nowMs: NOW })).toBeNull();
        const mixed = [...four.slice(0, 2), { name: 'e', attention: { level: 'look' as const, reasons: [disk] } }];
        expect(describeFleetDescription({ subjects: mixed, reportingCount: 3, onlineCount: 3, nowMs: NOW })).toBeNull();
        expect(describeFleetTitle({ subjects: [fleet[2]!], reportingCount: 1 })).toBe('All calm');
        expect(describeFleetDescription({ subjects: [fleet[2]!], reportingCount: 1, onlineCount: 3, nowMs: NOW })).toBe('Nothing on the 3 machines online needs you.');
        // One machine online: "every machine" would be a crowd.
        expect(describeFleetDescription({ subjects: [fleet[2]!], reportingCount: 1, onlineCount: 1, nowMs: NOW })).toBe('Nothing on the one machine online needs you.');
    });

    it('never calls a fleet calm while a row shows failing services (TH D-H)', () => {
        // The table's Work cell reads "8 services · 8 failing" from the same published facts.
        const failing = { name: 'eadc', attention: calm, failingServices: 8 };
        const quiet = { name: '5964', attention: calm, failingServices: 0 };
        expect(describeFleetTitle({ subjects: [failing, quiet], reportingCount: 2 })).toBe('eadc has 8 failing services');
        expect(describeFleetDescription({ subjects: [failing, quiet], reportingCount: 2, onlineCount: 2, nowMs: NOW }))
            .toBe('The other one online is calm.');
        expect(describeFleetTitle({ subjects: [failing, fleet[1]!], reportingCount: 2 })).toBe('2 machines need a look');
        expect(describeFleetDescription({ subjects: [failing, fleet[1]!], reportingCount: 2, onlineCount: 2, nowMs: NOW })).toBeNull();
        expect(describeFleetTitle({ subjects: [{ ...failing, failingServices: 1 }], reportingCount: 1 })).toBe('eadc has a failing service');
        // With no title above it (the Needs-you list shows), the sentence carries its own antecedent (TH MB-2).
        expect(describeFleetDescription({ subjects: [failing, fleet[1]!, quiet], reportingCount: 3, onlineCount: 5, nowMs: NOW, titleShown: false }))
            .toBe('2 machines need a look. The other 3 online are calm.');
        expect(describeFleetDescription({ subjects: [failing, fleet[1]!], reportingCount: 2, onlineCount: 2, nowMs: NOW, titleShown: false }))
            .toBe('2 machines need a look.');
    });

    it('names the machine and reason in the rail tooltip, or counts several that need you', () => {
        expect(describeMachinesRailTooltip({ needsYouCount: 1, subject: fleet[1]!, guard: null, presence: null })).toBe('edge-1 is short on memory');
        expect(describeMachinesRailTooltip({ needsYouCount: 2, subject: null, guard: null, presence: null })).toBe('2 machines need you');
        expect(describeMachinesRailTooltip({ needsYouCount: 0, subject: null, guard: null, presence: '6 online' })).toBe('6 online');
    });

    it('leads a machine sentence with its reason only when it needs a look', () => {
        expect(describeMachineSentence({ attention: fleet[1]!.attention, working: 2, nowMs: NOW }))
            .toEqual({ lead: 'Short on memory.', rest: 'Swapping for 6 min. 2 sessions working.', tone: 'needs_you' });
        expect(describeMachineSentence({ attention: calm, working: 3, nowMs: NOW }))
            .toEqual({ lead: 'Calm.', rest: '3 sessions working.', tone: 'calm' });
        expect(describeMachineSentence({ attention: calm, working: 1, nowMs: NOW })?.rest).toBe('1 session working.');
        expect(describeMachineSentence({ attention: null, working: 0, nowMs: NOW })).toBeNull();
        expect(describeMachineAttentionWord(disk)).toBe('/data nearly full');
    });

    it('names an unnamed root disk in plain words, never a bare slash', () => {
        const root: MachineResourceReasonV1 = { ...disk, volumeLabel: '/' };
        expect(describeMachineAttentionWord(root)).toBe('System disk nearly full');
        expect(describeMachineReasonPhrase('nl2', root)).toBe('nl2’s system disk is nearly full');
        expect(describeMachineReasonPhrase('nl2', disk)).toBe('nl2’s /data is nearly full');
    });

    it('replaces held attention and working counts with presence when offline', () => {
        expect(describeMachineSentence({ attention: fleet[1]!.attention, working: 2, nowMs: NOW,
            online: false, offlineLine: 'Offline · last seen yesterday' }))
            .toEqual({ lead: 'Offline · last seen yesterday', rest: '', tone: 'calm' });
    });
});

describe('a row’s one labelled value (owner bar 11-16: no unlabelled sparks in rows)', () => {
    const figures = { cpu: { figure: '41%' }, memory: { figure: '82%' }, disk: { figure: '12 GB' }, network: { figure: '2 MB/s' } };
    it('gives the value of the metric that needs attention, which its word labels', () => {
        expect(describeMachineAttentionFigure(memory, figures)).toBe('82%');
        expect(describeMachineAttentionFigure(disk, figures)).toBe('12 GB');
    });
    it('gives no value for a limit, or before a reading arrives', () => {
        expect(describeMachineAttentionFigure({ key: 'files', level: 'look', since: NOW, metric: 'limits', kind: 'limit_reached', limit: 'files', used: 9, max: 10 }, figures)).toBeNull();
        expect(describeMachineAttentionFigure(memory, null)).toBeNull();
    });
});

describe('a reason’s one action (plan 40 STO-23)', () => {
    it('opens Storage prepared for the full disk it names, and Processes sorted for memory', () => {
        expect(resolveMachineReasonAction(disk)?.tab).toEqual({ id: 'storage', prepare: 'lowDisk', volumeId: 'v' });
        expect(resolveMachineReasonAction(memory)?.tab).toEqual({ id: 'processes', sort: 'memory' });
        expect(machineResourceAlertTab('disk_nearly_full', 'v')).toEqual({ id: 'storage', prepare: 'lowDisk', volumeId: 'v' });
        expect(machineResourceAlertTab('disk_nearly_full')).toEqual({ id: 'storage' });
    });
});
