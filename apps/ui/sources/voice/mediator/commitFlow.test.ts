import { describe, expect, it } from 'vitest';
import { runVoiceMediatorCommitFlow } from './commitFlow';

describe('runVoiceMediatorCommitFlow', () => {
    it('alerts and does nothing when mediator is not active', async () => {
        const alerts: Array<{ title: string; message: string }> = [];
        let committed = false;
        let sent = false;

        await runVoiceMediatorCommitFlow({
            isActive: () => false,
            commit: async () => {
                committed = true;
                return 'x';
            },
            confirmSend: async () => true,
            applyToComposer: () => {},
            sendToSession: async () => {
                sent = true;
            },
            alert: async (title, message) => {
                alerts.push({ title, message });
            },
        });

        expect(committed).toBe(false);
        expect(sent).toBe(false);
        expect(alerts.length).toBe(1);
    });

    it('applies commit text and sends when confirmed', async () => {
        const applied: string[] = [];
        let sent: string | null = null;

        await runVoiceMediatorCommitFlow({
            isActive: () => true,
            commit: async () => 'COMMIT_TEXT',
            confirmSend: async () => true,
            applyToComposer: (text) => applied.push(text),
            sendToSession: async (text) => {
                sent = text;
            },
            alert: async () => {},
        });

        expect(applied).toEqual(['COMMIT_TEXT']);
        expect(sent).toBe('COMMIT_TEXT');
    });

    it('applies commit text but does not send when not confirmed', async () => {
        const applied: string[] = [];
        let sent = false;

        await runVoiceMediatorCommitFlow({
            isActive: () => true,
            commit: async () => 'COMMIT_TEXT',
            confirmSend: async () => false,
            applyToComposer: (text) => applied.push(text),
            sendToSession: async () => {
                sent = true;
            },
            alert: async () => {},
        });

        expect(applied).toEqual(['COMMIT_TEXT']);
        expect(sent).toBe(false);
    });

    it('alerts when commit generation fails', async () => {
        const alerts: Array<{ title: string; message: string }> = [];

        await runVoiceMediatorCommitFlow({
            isActive: () => true,
            commit: async () => {
                throw new Error('commit failed');
            },
            confirmSend: async () => true,
            applyToComposer: () => {},
            sendToSession: async () => {},
            alert: async (title, message) => {
                alerts.push({ title, message });
            },
        });

        expect(alerts).toEqual([{ title: 'Error', message: 'commit failed' }]);
    });

    it('alerts when send fails after confirmation', async () => {
        const alerts: Array<{ title: string; message: string }> = [];

        await runVoiceMediatorCommitFlow({
            isActive: () => true,
            commit: async () => 'COMMIT_TEXT',
            confirmSend: async () => true,
            applyToComposer: () => {},
            sendToSession: async () => {
                throw new Error('send failed');
            },
            alert: async (title, message) => {
                alerts.push({ title, message });
            },
        });

        expect(alerts).toEqual([{ title: 'Error', message: 'send failed' }]);
    });
});
