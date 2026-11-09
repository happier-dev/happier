import { describe, expect, it } from 'vitest';
import type { SystemTaskEvent } from '@happier-dev/protocol/system/tasks/spec';
import { t } from '@/text';
import { presentActiveCliAcquisition, presentCliAcquisitionEvent } from './cliAcquisitionPresentation';
import { createPlanChecklistLogEntryFromSystemTaskEvent } from './planChecklist/systemTaskEventLogEntry';

function event(data: SystemTaskEvent['data']): SystemTaskEvent {
    return { protocolVersion: 1, taskId: 'task', tsMs: 1, type: 'cli.acquisition.progress',
        stepId: 'setup.thisComputer.ensureCli', data };
}

describe('CLI acquisition presentation', () => {
    it('formats transfer counters with and without a known total through the same checklist presentation', () => {
        const sample = event({ phase: 'downloading', receivedBytes: 1024 });
        const presentation = presentCliAcquisitionEvent(sample);
        expect(presentation).toEqual({
            status: t('cliAcquisitionProgress.acquisitionDownloadingStatus'),
            downloadProgress: t('cliAcquisitionProgress.acquisitionDownloadBytes', { received: '1.02 KB' }),
        });
        expect(createPlanChecklistLogEntryFromSystemTaskEvent(sample, () => 'Install tools', 0)).toMatchObject({
            message: presentation?.status, details: presentation?.downloadProgress,
        });
        expect(presentCliAcquisitionEvent(event({ phase: 'downloading', receivedBytes: 1024, totalBytes: 2048 }))).toEqual({
            status: t('cliAcquisitionProgress.acquisitionDownloadingStatus'),
            downloadProgress: t('cliAcquisitionProgress.acquisitionDownloadBytesTotal', { received: '1.02 KB', total: '2.05 KB' }),
        });
        expect(presentCliAcquisitionEvent(event({ phase: 'verifying', receivedBytes: 1024 })))
            .toEqual({ status: t('cliAcquisitionProgress.acquisitionVerifyingStatus'), downloadProgress: undefined });
    });

    it('falls back for unknown or malformed phases and hides byte counters on failure, prompts and cancellation', () => {
        expect(presentCliAcquisitionEvent(event({ phase: 'futurePhase' }))).toBeNull();
        expect(presentCliAcquisitionEvent(event({ phase: 'downloading', receivedBytes: -1 }))).toBeNull();
        expect(presentCliAcquisitionEvent(event({ phase: 'downloading', receivedBytes: 1024, failure: { cause: 'secret URL' } })))
            .toEqual({ status: t('cliAcquisitionProgress.acquisitionDownloadFailed') });
        const snapshot = {
            taskId: 'task', status: 'running' as const, currentStepId: null, latestMessage: null,
            awaitingInput: false, cancelRequested: false, result: null,
            events: [event({ phase: 'downloading', receivedBytes: 1024 })],
        };
        expect(presentActiveCliAcquisition({ ...snapshot, status: 'canceling' })).toBeNull();
        expect(presentActiveCliAcquisition({ ...snapshot, awaitingInput: true })).toBeNull();
        expect(presentActiveCliAcquisition({ ...snapshot, events: [...snapshot.events, { ...event({}), type: 'progress' }] })).toBeNull();
    });
});
