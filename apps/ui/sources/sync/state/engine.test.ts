import { describe, expect, it } from 'vitest';
import { SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

import type { Metadata } from '@happier-dev/session-core/state';
import { writeUiSessionStateField } from './engine';
import { createSessionBotUndoMetadataPreprocess } from '@/sync/ops/sessions/sessionBotUndo';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('writeUiSessionStateField', () => {
    it('applies registered Bot and view Actions through real bindings to Account persistence', async () => {
        let metadata = buildMetadata({ summary: { text: 'Keep', updatedAt: 1 },
            work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep' }, viewPreferences: { showToolCalls: true } } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionStateFieldSet: write => writeUiSessionStateField({
                sessionId: write.sessionId, fieldId: write.fieldId,
                value: write.fieldId === 'display.title' ? { title: String(write.value) } : write.value,
                metadataReason: 'registered-field-action',
                // The persistence transport is the only replaced boundary.
                updateSessionMetadataWithRetry: async (_id, updater) => {
                    metadata = updater(metadata);
                    return { version: 5 };
                },
            }),
        }));
        expect(await executor.execute('session.title.set', { sessionId: 's1', title: 'Renamed' }, { surface: 'cli' }))
            .toMatchObject({ ok: true, result: { ok: true, version: 5 } });
        expect(metadata.summary?.text).toBe('Renamed');
        expect(await executor.execute('session.bot.set', { sessionId: 's1', bot: { kind: 'bot' } }, { surface: 'cli' }))
            .toMatchObject({ ok: true, result: { ok: true, version: 5 } });
        expect(metadata).toMatchObject({ bot: { kind: 'bot' }, work: { memoryEnabled: false, viewPreferences: { showToolCalls: true } } });
        expect(await executor.execute('session.view.toolCalls.set', { sessionId: 's1', showToolCalls: false },
            { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
        expect(await executor.execute('session.bot.set', { sessionId: 's1', bot: null }, { surface: 'cli' })).toMatchObject({ ok: true });
        expect(metadata).not.toHaveProperty('bot');
        expect(metadata.work?.viewPreferences?.showToolCalls).toBe(false);
        expect(await executor.execute('session.view.toolCalls.set', { sessionId: 's1', showToolCalls: null },
            { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
        expect(metadata.work?.viewPreferences?.showToolCalls).toBeUndefined();
        expect(metadata.work?.sessionRolesV1?.notes).toBe('Keep');
        expect(metadata.summary?.text).toBe('Renamed');
    });
    it('refuses a Bot inverse when refreshed metadata no longer contains the accepted marker', async () => {
        const changed = buildMetadata({ work: { viewPreferences: { showToolCalls: true } } });
        let persisted = changed;
        const result = await writeUiSessionStateField({ sessionId: 's1', fieldId: 'display.bot', value: null,
            metadataReason: 'ui-bot-undo', metadataPreprocess: createSessionBotUndoMetadataPreprocess({ kind: 'bot' }),
            updateSessionMetadataWithRetry: async (_id, updater) => {
                persisted = updater(changed);
                return { version: 10 };
            } });
        expect(result).toEqual({ ok: false, reason: 'conflict' });
        expect(persisted).toBe(changed);
    });
    it('persists and clears only the tool visibility override through Account metadata without a runtime facet', async () => {
        let metadata = buildMetadata({ summary: { text: 'Name', updatedAt: 12 },
            work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep' } } });
        const updateSessionMetadataWithRetry = async (_id: string, updater: (value: Metadata) => Metadata) => {
            metadata = updater(metadata);
            return { version: 9 };
        };
        for (const value of [false, true, null] as const) {
            expect(await writeUiSessionStateField({ sessionId: 's1', fieldId: 'view.transcriptToolCalls', value,
                metadataReason: 'ui-tool-visibility', updateSessionMetadataWithRetry })).toEqual({ ok: true, version: 9 });
            expect(metadata.work?.viewPreferences?.showToolCalls).toBe(value ?? undefined);
            expect(metadata.work?.sessionRolesV1?.notes).toBe('Keep');
            expect(metadata.summary).toEqual({ text: 'Name', updatedAt: 12 });
        }
    });
    it('persists Bot promotion and demotion through the Account metadata port without a runtime facet', async () => {
        let metadata = buildMetadata({ summary: { text: 'Name', updatedAt: 12 } });
        const updateSessionMetadataWithRetry = async (_sessionId: string, updater: (value: Metadata) => Metadata) => {
            metadata = updater(metadata);
            return { version: 9 };
        };
        expect(await writeUiSessionStateField({ sessionId: 's1', fieldId: 'display.bot', value: { kind: 'bot' },
            metadataReason: 'ui-bot', updateSessionMetadataWithRetry })).toEqual({ ok: true, version: 9 });
        expect(metadata).toMatchObject({ bot: { kind: 'bot' }, summary: { text: 'Name', updatedAt: 12 } });
        expect(await writeUiSessionStateField({ sessionId: 's1', fieldId: 'display.bot', value: null,
            metadataReason: 'ui-bot', updateSessionMetadataWithRetry })).toEqual({ ok: true, version: 9 });
        expect(metadata).not.toHaveProperty('bot');
        expect(metadata.summary).toEqual({ text: 'Name', updatedAt: 12 });
    });
    it('routes UI writes through the session-state engine metadata port', async () => {
        const updates: Metadata[] = [];

        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'intent.model',
            value: SessionModelSelectionIntentV1Schema.parse({
                v: 1,
                updatedAt: 12,
                selection: {
                    agentTargetKey: 'agent:happier.agent.gemini/gemini',
                    providerConnectionId: null,
                    modelId: 'gemini-2.5-pro',
                },
            }),
            metadataReason: 'ui-model-override',
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
                return { version: 7 };
            },
        });

        expect(result).toEqual({ ok: true, version: 7 });
        expect(updates).toEqual([
            expect.objectContaining({
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 12,
                    selection: {
                        agentTargetKey: 'agent:happier.agent.gemini/gemini',
                        providerConnectionId: null,
                        modelId: 'gemini-2.5-pro',
                    },
                },
            }),
        ]);
    });

    it('lets the UI title publisher preserve explicit title timestamps through the engine port', async () => {
        const updates: Metadata[] = [];

        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
                return { version: 8 };
            },
            metadataPostprocess: (metadata) => ({
                ...metadata,
                voiceScope: { kind: 'voice_home' },
            }),
        });

        expect(result).toEqual({ ok: true, version: 8 });
        expect(updates).toEqual([
            expect.objectContaining({
                summary: {
                    text: 'Published title',
                    updatedAt: 13,
                },
                voiceScope: { kind: 'voice_home' },
            }),
        ]);
    });

    it('maps UI metadata authorization failures to forbidden', async () => {
        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            updateSessionMetadataWithRetry: async () => {
                throw new Error('not authenticated');
            },
        });

        expect(result).toEqual({ ok: false, reason: 'forbidden' });
    });

    it('maps canonical forbidden ACK failures to forbidden', async () => {
        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            updateSessionMetadataWithRetry: async () => {
                throw Object.assign(new Error('Forbidden session metadata update'), {
                    code: 'forbidden' as const,
                });
            },
        });

        expect(result).toEqual({ ok: false, reason: 'forbidden' });
    });

    it('passes maxAttempts through the UI metadata update port', async () => {
        const calls: unknown[] = [];

        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            maxAttempts: 3,
            updateSessionMetadataWithRetry: async (sessionId, updater, opts) => {
                calls.push({
                    sessionId,
                    opts,
                    metadata: updater(buildMetadata()),
                });
                return { version: 9 };
            },
        });

        expect(result).toEqual({ ok: true, version: 9 });
        expect(calls).toEqual([{
            sessionId: 's1',
            opts: { maxAttempts: 3 },
            metadata: expect.objectContaining({
                summary: { text: 'Published title', updatedAt: 13 },
            }),
        }]);
    });
});
