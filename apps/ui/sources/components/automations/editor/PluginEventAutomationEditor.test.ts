import { describe, expect, it, vi } from 'vitest';

const alertMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/modal', () => ({ Modal: { alert: alertMock } }));

import {
    completePluginEventAutomationEditor,
    resolvePluginEventAutomationEditorCompletion,
    resolvePluginEventEditorProjectionMachineId,
} from './PluginEventAutomationEditor';

describe('resolvePluginEventEditorProjectionMachineId', () => {
    it('keeps Event transport placement distinct from the Automation execution assignment', () => {
        expect(resolvePluginEventEditorProjectionMachineId({
            observation: null,
            authoringMachineId: 'execution-assignment-machine',
        })).toBe('execution-assignment-machine');

        expect(resolvePluginEventEditorProjectionMachineId({
            observation: {
                kind: 'checkpointedPull',
                watcherMaterializationRef: { machineId: 'watcher-machine' },
            },
            authoringMachineId: 'execution-assignment-machine',
        })).toBe('watcher-machine');

        expect(resolvePluginEventEditorProjectionMachineId({
            observation: {
                kind: 'durablePush',
                endpointMaterializationRef: { machineId: 'endpoint-machine' },
            },
            authoringMachineId: 'execution-assignment-machine',
        })).toBe('endpoint-machine');

        expect(resolvePluginEventEditorProjectionMachineId({
            observation: {
                kind: 'durablePush',
                endpointMaterializationRef: null,
            },
            authoringMachineId: 'execution-assignment-machine',
        })).toBeNull();
    });

    it('rejects completion when the selected materialization is no longer current', () => {
        expect(resolvePluginEventAutomationEditorCompletion({
            eligibleEvents: [],
            createDraft: {
                draft: {} as never,
                resolveFreshWatcherOrigin: () => null,
            },
        } as never)).toBeNull();
    });

    it('invalidates stale configured source facts and exposes recovery instead of silently no-oping', async () => {
        const invalidateConfiguredSource = vi.fn();
        const onComplete = vi.fn();
        alertMock.mockClear();

        await completePluginEventAutomationEditor({
            eligibleEvents: [],
            createDraft: {
                draft: {} as never,
                resolveFreshWatcherOrigin: () => null,
            },
            invalidateConfiguredSource,
        } as never, onComplete);

        expect(invalidateConfiguredSource).toHaveBeenCalledTimes(1);
        expect(onComplete).not.toHaveBeenCalled();
        expect(alertMock).toHaveBeenCalledWith(
            'Error',
            expect.any(String),
        );
    });
});
