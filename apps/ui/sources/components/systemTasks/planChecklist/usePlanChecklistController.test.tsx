import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import type { PlanChecklistExecutionState } from './types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            borderRadius: { modalCard: 14 },
            colors: {
                text: '#111',
                textSecondary: '#666',
                textTertiary: '#999',
                surface: '#fff',
                surfaceHigh: '#f9f9f9',
                surfacePressed: '#f2f2f2',
                surfacePressedOverlay: '#fafafa',
                surfaceSelected: '#f8f8f8',
                divider: '#ddd',
                accent: { blue: '#007aff' },
                success: '#34c759',
                warningCritical: '#ff3b30',
            },
        },
    });
});

afterEach(() => {
    standardCleanup();
});

describe('usePlanChecklistController', () => {
    it('uses default-selected items, blocks disabled items, and enters execute phase', async () => {
        const { usePlanChecklistController } = await import('./usePlanChecklistController');

        const items = [
            {
                id: 'install_cli',
                title: 'Install CLI',
                satisfied: false,
                disabled: false,
                defaultSelected: true,
            },
            {
                id: 'pair_machine',
                title: 'Pair machine',
                satisfied: false,
                disabled: true,
                defaultSelected: false,
            },
        ] as const;

        const buildExecutionPlan = vi.fn((selectedIds: readonly string[]) => ({ selectedIds }));
        const runExecutionPlan = vi.fn(async (_plan: { selectedIds: readonly string[] }, publish: (snapshot: { step: string }) => void) => {
            publish({ step: 'install_cli' });
        });

        const hook = await renderHook(() => usePlanChecklistController({
            items,
            buildExecutionPlan,
            runExecutionPlan,
            mapExecutionSnapshotToRowState: (snapshot) => {
                if (snapshot.step === 'install_cli') {
                    const runningState: PlanChecklistExecutionState = {
                        status: 'running',
                        logs: [
                            { ts: 10, level: 'info', message: 'Installing CLI' },
                        ],
                    };
                    return { install_cli: runningState };
                }
                return {};
            },
        }));

        expect(hook.getCurrent().selectedIds).toEqual(['install_cli']);

        await act(async () => {
            hook.getCurrent().toggleItem('pair_machine');
        });
        expect(hook.getCurrent().selectedIds).toEqual(['install_cli']);

        await act(async () => {
            hook.getCurrent().toggleItem('install_cli');
        });
        expect(hook.getCurrent().selectedIds).toEqual([]);

        await act(async () => {
            await hook.getCurrent().continue();
        });

        expect(buildExecutionPlan).toHaveBeenCalledWith([]);
        expect(runExecutionPlan).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().phase).toBe('execute');
        expect(hook.getCurrent().executionById.install_cli?.status).toBe('running');
    });

    it('tracks expanded rows and retries the same plan', async () => {
        const { usePlanChecklistController } = await import('./usePlanChecklistController');

        const items = [
            {
                id: 'install_cli',
                title: 'Install CLI',
                satisfied: false,
                disabled: false,
                defaultSelected: true,
            },
        ] as const;

        const buildExecutionPlan = vi.fn((selectedIds: readonly string[]) => ({ selectedIds }));
        const runExecutionPlan = vi.fn(async (_plan: { selectedIds: readonly string[] }, publish: (snapshot: { status: string }) => void) => {
            publish({ status: 'done' });
        });

        const hook = await renderHook(() => usePlanChecklistController({
            items,
            buildExecutionPlan,
            runExecutionPlan,
            mapExecutionSnapshotToRowState: (snapshot) => {
                const doneState: PlanChecklistExecutionState = {
                    status: snapshot.status === 'done' ? 'done' : 'running',
                    logs: [],
                };
                return { install_cli: doneState };
            },
        }));

        await act(async () => {
            hook.getCurrent().toggleExpanded('install_cli');
        });
        expect(hook.getCurrent().expandedIds).toEqual(['install_cli']);

        await act(async () => {
            await hook.getCurrent().continue();
        });
        expect(hook.getCurrent().executionById.install_cli?.status).toBe('done');

        await act(async () => {
            await hook.getCurrent().retry();
        });
        expect(runExecutionPlan).toHaveBeenCalledTimes(2);
    });

    it('can normalize selection dependencies', async () => {
        const { usePlanChecklistController } = await import('./usePlanChecklistController');

        const items = [
            { id: 'install_service', title: 'Install service', satisfied: false, disabled: false, defaultSelected: true },
            { id: 'start_service', title: 'Start service', satisfied: false, disabled: false, defaultSelected: true },
            { id: 'verify_service', title: 'Verify service', satisfied: false, disabled: false, defaultSelected: true },
        ] as const;

        const hook = await renderHook(() => usePlanChecklistController({
            items,
            normalizeSelectedIds: (selectedIds) => {
                const set = new Set(selectedIds);
                if (!set.has('install_service')) {
                    set.delete('start_service');
                    set.delete('verify_service');
                }
                if (!set.has('start_service')) {
                    set.delete('verify_service');
                }
                return [...set];
            },
            buildExecutionPlan: (selectedIds) => ({ selectedIds }),
            runExecutionPlan: async () => undefined,
            mapExecutionSnapshotToRowState: () => ({}),
        }));

        expect(new Set(hook.getCurrent().selectedIds)).toEqual(new Set(['install_service', 'start_service', 'verify_service']));

        await act(async () => {
            hook.getCurrent().toggleItem('install_service');
        });

        expect(hook.getCurrent().selectedIds).toEqual([]);
    });
});
