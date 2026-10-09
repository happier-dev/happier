import { describe, expect, it } from 'vitest';

import { createDaemonAdmissionDrain, waitForDaemonAdmission } from './admissionDrain';

describe('daemon admission drain', () => {
    it('reopens unused-stop without clearing independent temporary refusal or plugin decisions', async () => {
        const drain = createDaemonAdmissionDrain();
        drain.beginTemporaryDrain();
        drain.beginUnusedStopDrain();
        drain.resumeUnusedStop();
        expect(drain.isQuiescing()).toBe(true);
        expect(drain.isPublicationQuiescing()).toBe(false);
        let executed = false;
        const admitted = waitForDaemonAdmission(drain).then(() => { executed = true; });
        await Promise.resolve();
        expect(executed).toBe(false);
        drain.resume();
        await admitted;
        expect(executed).toBe(true);
        drain.beginUnusedStopDrain();
        drain.resume();
        expect(drain.isQuiescing()).toBe(true);
        drain.resumeUnusedStop();
        expect(drain.isQuiescing()).toBe(false);
    });
    it('retains a waiting leaf through temporary drain and releases it only on reopen', async () => {
        const drain = createDaemonAdmissionDrain();
        drain.beginTemporaryDrain();
        let started = false;
        const leaf = waitForDaemonAdmission(drain).then(() => { started = true; });
        await Promise.resolve();
        expect(started).toBe(false);
        drain.resume();
        await leaf;
        expect(started).toBe(true);
        drain.beginTemporaryDrain();
        const cancelled = new AbortController();
        const parked = waitForDaemonAdmission(drain, cancelled.signal);
        cancelled.abort(new Error('claim_cancelled'));
        await expect(parked).rejects.toThrow('claim_cancelled');
        const shutdownLeaf = waitForDaemonAdmission(drain);
        drain.beginShutdown();
        await expect(shutdownLeaf).rejects.toMatchObject({ code: 'daemon_shutting_down' });
    });
    it('reopens only its temporary cause and preserves plugin handoff exclusion', () => {
        let pluginHandoff = false;
        const drain = createDaemonAdmissionDrain({ isPluginHandoffQuiescing: () => pluginHandoff });
        drain.beginTemporaryDrain();
        expect(drain.isQuiescing()).toBe(true);
        expect(drain.isPublicationQuiescing()).toBe(false);
        pluginHandoff = true;
        drain.resume();
        expect(drain.isQuiescing()).toBe(true);
        expect(drain.isPublicationQuiescing()).toBe(true);
        pluginHandoff = false;
        drain.notifyPluginHandoffChanged();
        expect(drain.isQuiescing()).toBe(false);
        drain.beginTemporaryDrain();
        pluginHandoff = true;
        drain.notifyPluginHandoffChanged();
        pluginHandoff = false;
        drain.notifyPluginHandoffChanged();
        expect(drain.isQuiescing()).toBe(true);
        drain.resume();
        drain.beginShutdown();
        drain.resume();
        expect(drain.isFinalShutdown()).toBe(true);
    });
});
